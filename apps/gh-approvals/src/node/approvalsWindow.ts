import { UIHost } from '@cmdless/ui-sdk/node';
import { approvalsProtocol } from '../shared/protocols.js';
import { page } from './page.js';

export type ApprovalsStore = Awaited<ReturnType<typeof approvalsProtocol.createStore>>;

export type ApprovalsWindowParams = { store: ApprovalsStore; title?: string };

// a window on everyone's items, served from the tray's own store - which it
// keeps up to date whether a window is open or not
export const approvalsWindow = UIHost.factory((opener, { store, title }: ApprovalsWindowParams) =>
  opener.openWindow({
    type: 'file', source: page('/approvals'), window: { title, width: 1000, height: 700 },
    backend: approvalsProtocol.accept(undefined, store),
  }));
