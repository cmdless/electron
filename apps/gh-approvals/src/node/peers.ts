import { defineProtocol } from '@cmdless/rpc-sdk';
import type { IncomingChannel, RtcHost } from '@cmdless/rtc-sdk/node';
import type { Item, Items } from './items.js';

// something one tray can send another: a pull request to review, or a
// deployment to approve - what it is, and where
export type SentItem = Pick<Item, 'kind' | 'title' | 'url'>;

// what each tray says about itself: whose it is, and which run of it this is
// - a tray is connected to once a run
export type TrayInfo = { user: string; session: string };

// the channel trays talk over, one each way between every two - its label
// says whose tray opened it
const TRAY_LABEL = 'gh-approvals/tray/';
export const userOf = (label: string) => label.startsWith(TRAY_LABEL) ? label.slice(TRAY_LABEL.length) || undefined : undefined;

// Every running tray is an RTC host on the share, serving its user's items to
// every other one, and connected to every other one for theirs. A tray is
// listed only while its connection is open. Whoever can write the share can
// reach them all - the share is the trust.
export const trayProtocol = defineProtocol(({ side, request, state }) => ({
  name: 'gh-approvals/tray',
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
  state: {
    // what's waiting on its user, kept up to date as it changes
    items: state<Items>('items'),
  },
}));

export type Tray = ReturnType<typeof trayProtocol.createClient>;
export type TrayStore = Awaited<ReturnType<typeof trayProtocol.createStore>>;

export type TrayHandlers = {
  refresh(from: string): void;
  requestApproval(from: string, item: SentItem): void;
  approve(from: string, url: string, environment?: number): Promise<void>;
};

// another tray's channel to this one, served from this tray's store -
// everything it asks is from its user
export function serve(channel: IncomingChannel, from: string, store: TrayStore, handlers: TrayHandlers) {
  trayProtocol.accept(server => {
    server.onRequest.refresh(() => handlers.refresh(from));
    server.onRequest.requestApproval(({ item }) => handlers.requestApproval(from, item));
    server.onRequest.approve(({ url, environment }) => handlers.approve(from, url, environment));
  }, store)(channel.connection()).listen();
}

// a connection to another tray, as this user's, and the channel to ask it
// things on and follow its items through
export async function connect(host: RtcHost<TrayInfo>, deviceId: string, user: string) {
  const link = await host.connect(deviceId);
  try {
    const tray = trayProtocol.createClient((await link.open(`${TRAY_LABEL}${user}`)).connection());
    tray.listen();
    await tray.checkVersion();
    return { tray, onClose: link.onClose, close: link.close };
  } catch (error) {
    link.close();
    throw error;
  }
}
