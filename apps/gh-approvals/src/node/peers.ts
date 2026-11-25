import net from 'node:net';
import type { AddressInfo, Socket } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { defineProtocol } from '@cmdless/rpc-sdk';
import { createSocket } from '@cmdless/rpc-sdk/node';
import type { Item, UserFile } from './files.js';

// something one tray can send another: a pull request to review, or a
// deployment to approve - what it is, and where
export type SentItem = Pick<Item, 'kind' | 'title' | 'url'>;

// how long a tray's machine gets to answer before it counts as unreachable
const CONNECT_TIMEOUT_MS = 2_000;

// how soon a quiet connection starts checking the other end is still there -
// so a machine that sleeps or drops off the network is noticed by the OS,
// without anything here keeping time
const KEEPALIVE_MS = 30_000;

// Every running tray listens, and says where in its user.json, with a token
// that a connection has to say hello with before anything else - so only
// someone who can read the data folder can reach it. The folder is the trust.
// Each tray keeps a connection open to every other one; a tray is listed only
// while its connection is open.
export const peerProtocol = defineProtocol(({ side, request }) => ({
  name: 'gh-approvals/peer',
  clientToServer: side({
    requests: {
      // first, and once: who's connecting, with the token
      hello: request<{ token: string; from: string }>('hello'),
      // look again, now: someone pressed Check Now, or changed their files
      refresh: request<void>('refresh'),
      // tell its user someone wants them to approve one of their items
      requestApproval: request<{ item: SentItem }>('request-approval'),
      // approve one of its user's items, with their account, now - a
      // deployment in one environment
      approve: request<{ url: string; environment?: number }>('approve'),
    },
  }),
}));

export type Peer = ReturnType<typeof peerProtocol.createClient>;

export type PeerHandlers = {
  refresh(from: string): void;
  requestApproval(from: string, item: SentItem): void;
  approve(from: string, url: string, environment?: number): Promise<void>;
};

export const newToken = () => randomBytes(32).toString('base64url');

const sameToken = (presented: string, token: string) =>
  presented.length === token.length && timingSafeEqual(Buffer.from(presented), Buffer.from(token));

// this tray's listener, on whatever port is free: a connection gets nowhere
// until it's said hello with the token. Closing it hangs up on everyone, so
// they drop this tray straight away.
export async function listen(token: string, handlers: PeerHandlers) {
  const sockets = new Set<Socket>();
  const server = net.createServer(socket => {
    socket.setKeepAlive(true, KEEPALIVE_MS);
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    let from: string | undefined;
    const caller = () => {
      if (from === undefined) throw new Error('hello first');
      return from;
    };
    const peer = peerProtocol.createServer(createSocket(socket));
    peer.onRequest.hello(({ token: presented, from: name }) => {
      // refused - and whatever else it asks is too, until it hangs up
      if (!sameToken(presented, token)) throw new Error('wrong token');
      from = name;
    });
    peer.onRequest.refresh(() => handlers.refresh(caller()));
    peer.onRequest.requestApproval(({ item }) => handlers.requestApproval(caller(), item));
    peer.onRequest.approve(({ url, environment }) => handlers.approve(caller(), url, environment));
    peer.listen();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port: 0, host: '0.0.0.0' }, () => { server.off('error', reject); resolve(); });
  });
  return {
    port: (server.address() as AddressInfo).port,
    close() {
      server.close();
      for (const socket of sockets) socket.destroy();
    },
  };
}

// a connection to another tray, said hello on - given up on if its machine
// doesn't answer in time
export function connect({ token, endpoint }: UserFile, from: string) {
  return new Promise<Peer>((resolve, reject) => {
    const socket = net.connect({ host: endpoint.host, port: endpoint.port, timeout: CONNECT_TIMEOUT_MS });
    socket.once('connect', () => {
      socket.setTimeout(0);
      socket.setKeepAlive(true, KEEPALIVE_MS);
      const peer = peerProtocol.createClient(createSocket(socket));
      peer.listen();
      // hung up on before it's answered: nothing else will answer it
      const closed = peer.onClose(() => reject(new Error(`${endpoint.host} hung up`)));
      peer.request.hello({ token, from }).then(() => {
        closed.dispose();
        resolve(peer);
      }, error => {
        closed.dispose();
        peer.dispose();
        reject(error as Error);
      });
    });
    socket.once('timeout', () => { socket.destroy(); reject(new Error(`${endpoint.host} didn't answer`)); });
    socket.once('error', reject);
  });
}
