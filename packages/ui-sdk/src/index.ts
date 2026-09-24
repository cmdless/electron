import { defineProtocol, forElectronIPC } from '@cmdless/rpc-sdk';
import { Params } from './types.js';

export * from './emitter.js';
export * as types from './types.js';

export interface CmdlessState {
  node: boolean;
};

type ResolveParams<T = unknown> = {
  value: T;
  exitCode?: number;
};

export const cmdlessProtocol = defineProtocol(({ side, request, notification }) => ({
  clientToServer: side({
    requests: {
      state: request<void, CmdlessState>('state'),
      ui: request<Params, string>('ui'),
    },
    notifications: {
      resolve: notification<ResolveParams>('resolve'),
    },
  }),
  serverToClient: side({
    notifications: {
      state: notification<CmdlessState>('state'),
    },
  }),
}));

export const createElectronIPC = forElectronIPC('cmdless:rpc');

export type Cmdless = {
  ipc: ReturnType<typeof cmdlessProtocol.createClient>;
};