import { defineProtocol, forElectronIPC } from '@cmdless/rpc-sdk';
import type { AdaptiveCard, CardEvent, CardView, FormView } from './types.js';

export * as types from './types.js';
export * from './prompts.js';

type ResolveParams<T = unknown> = {
  value: T;
  exitCode?: number;
};

// where a window's backend is, and the single-use token that lets this
// window in - only ever seen by the window's preload, never its page
export type BackendCredentials = { url: string; token: string };

// what a window's preload can say to the host: resolve the window with a
// value, and ask for its backend
export const cmdlessIPC = defineProtocol(({ side, request, notification }) => ({
  clientToServer: side({
    requests: {
      connect: request<void, BackendCredentials>('connect'),
    },
    notifications: {
      resolve: notification<ResolveParams>('resolve'),
    },
  }),
}));

export const createElectronIPC = forElectronIPC('cmdless:rpc');

// what one of the host's own views shows - ui-runtime's card or form page
export type ViewProps = ({ view: 'card' } & CardView) | ({ view: 'form' } & FormView);

// how one of the host's own views talks to it: it asks what to show, says
// how tall its content is (for its window to fit it), reports a card's
// actions, and ends with a value; the host sends it a card to show instead
export const cmdlessViewIPC = defineProtocol(({ side, request, notification }) => ({
  clientToServer: side({
    requests: {
      props: request<void, ViewProps>('view/props'),
    },
    notifications: {
      event: notification<CardEvent>('view/event'),
      close: notification<{ value?: unknown }>('view/close'),
      resize: notification<{ height: number }>('view/resize'),
    },
  }),
  serverToClient: side({
    notifications: {
      update: notification<{ card: AdaptiveCard }>('view/update'),
    },
  }),
}));

export const createElectronViewIPC = forElectronIPC('cmdless:view');

// an open connection to a window's backend, held by the preload: the page
// can send and hear messages on it, and nothing more
export type CmdlessSocket = {
  send(message: string): void;
  onMessage(listener: (message: string) => void): void;
  onClose(listener: (code: number, reason: string) => void): void;
  close(): void;
};

// what a window's page gets as window.cmdless
export type Cmdless = {
  // ends the window with a value - or, with a non-zero exit code, as failed
  resolve(value: unknown, exitCode?: number): void;
  // opens a connection to the backend the window was opened with; use
  // connect() from @cmdless/ui-sdk/browser
  connect(): Promise<CmdlessSocket>;
  view: ReturnType<typeof cmdlessViewIPC.createClient>;
};
