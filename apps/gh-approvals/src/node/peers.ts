import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { defineProtocol } from '@cmdless/rpc-sdk';
import { createSocket, startSocket } from '@cmdless/rpc-sdk/node';
import type { Item, UserFile } from './files.js';

// something one tray can send another: a pull request to review, or a
// deployment to approve - what it is, and where
export type SentItem = Pick<Item, 'kind' | 'title' | 'url'>;

// how long a tray's machine gets to answer before it counts as unreachable
const CONNECT_TIMEOUT_MS = 2_000;

// Every running tray listens, and says where in its user.json, with a token
// that every request to it has to carry - so only someone who can read the
// data folder can reach it. The folder is the trust.
export const peerProtocol = defineProtocol(({ side, request }) => ({
  name: 'gh-approvals/peer',
  clientToServer: side({
    requests: {
      // look again, now: someone pressed Check now, or changed their files
      refresh: request<{ token: string; from: string }>('refresh'),
      send: request<{ token: string; from: string; item: SentItem }>('send'),
    },
  }),
}));

export const newToken = () => randomBytes(32).toString('base64url');

const sameToken = (presented: string, token: string) =>
  presented.length === token.length && timingSafeEqual(Buffer.from(presented), Buffer.from(token));

// this tray's listener, on whatever port is free: only requests carrying its
// token get through
export async function listen(token: string, handlers: {
  refresh(from: string): void;
  send(from: string, item: SentItem): void;
}) {
  const check = (presented: string) => {
    if (!sameToken(presented, token)) throw new Error('wrong token');
  };
  const accept = peerProtocol.accept(server => {
    server.onRequest.refresh(({ token: presented, from }) => {
      check(presented);
      handlers.refresh(from);
    });
    server.onRequest.send(({ token: presented, from, item }) => {
      check(presented);
      handlers.send(from, item);
    });
  });
  const server = await startSocket({ accept, options: { port: 0, host: '0.0.0.0' } });
  return { server, port: (server.address() as AddressInfo).port };
}

// a connection to another tray, given up on if its machine doesn't answer
// in time
function connect({ endpoint }: UserFile) {
  return new Promise<ReturnType<typeof peerProtocol.createClient>>((resolve, reject) => {
    const socket = net.connect({ host: endpoint.host, port: endpoint.port, timeout: CONNECT_TIMEOUT_MS });
    socket.once('connect', () => {
      socket.setTimeout(0);
      const client = peerProtocol.createClient(createSocket(socket));
      client.listen();
      resolve(client);
    });
    socket.once('timeout', () => { socket.destroy(); reject(new Error(`${endpoint.host} didn't answer`)); });
    socket.once('error', reject);
  });
}

// asks another tray something, with its token, then hangs up
async function ask<T>(peer: UserFile, request: (client: Awaited<ReturnType<typeof connect>>) => Promise<T>) {
  const client = await connect(peer);
  try {
    return await request(client);
  } finally {
    client.dispose();
  }
}

export function requestRefresh(peer: UserFile, from: string) {
  return ask(peer, client => client.request.refresh({ token: peer.token, from }));
}

export function sendTo(peer: UserFile, from: string, item: SentItem) {
  return ask(peer, client => client.request.send({ token: peer.token, from, item }));
}
