import { defineProtocol } from '@cmdless/rpc-sdk';
import type { RtcHost, RtcChannel } from '@cmdless/rtc-sdk/node';
import type { Item } from './files.js';

// something one tray can send another: a pull request to review, or a
// deployment to approve - what it is, and where
export type SentItem = Pick<Item, 'kind' | 'title' | 'url'>;

// what each tray says about itself: when its files last changed - so the
// others only re-read them when they have - and which run of it this is
export type TrayInfo = { lastUpdatedAt: string; session: string };

// the channel trays talk over, one each way between every two
export const PEER_LABEL = 'gh-approvals/peer';

// Every running tray is an RTC host on the data folder, and keeps a
// connection open to every other one; a tray is listed only while its
// connection is open. Whoever can write the folder can reach them all - the
// folder is the trust.
export const peerProtocol = defineProtocol(({ side, request }) => ({
  name: 'gh-approvals/peer',
  clientToServer: side({
    requests: {
      // look again, now: someone pressed Check Now
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

// another tray's channel to this one, served - everything it asks is from
// whoever it came from
export function serve(channel: RtcChannel & { from: string }, handlers: PeerHandlers) {
  const { from } = channel;
  peerProtocol.accept(server => {
    server.onRequest.refresh(() => handlers.refresh(from));
    server.onRequest.requestApproval(({ item }) => handlers.requestApproval(from, item));
    server.onRequest.approve(({ url, environment }) => handlers.approve(from, url, environment));
  })(channel.connection()).listen();
}

// a connection to another tray, and the channel to ask it things on
export async function connect(host: RtcHost<TrayInfo>, user: string) {
  const link = await host.connect(user);
  try {
    const peer = peerProtocol.createClient((await link.open(PEER_LABEL)).connection());
    peer.listen();
    return { peer, onClose: link.onClose, close: link.close };
  } catch (error) {
    link.close();
    throw error;
  }
}
