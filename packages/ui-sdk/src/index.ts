import { defineProtocol, forElectronIPC } from '@cmdless/rpc-sdk';
import { Params } from './types.js';

export * from './emitter.js';
export * from './app.js';
export * from './runtime.js';
export * as types from './types.js';

export interface CmdlessState {
  node: boolean;
};

type ResolveParams<T = unknown> = {
  value: T;
  exitCode?: number;
};

export type ConnectionInfo = {
  address?: string;
  windowId: number;
};

export const cmdlessIPC = defineProtocol(({ side, request, notification }) => ({
  clientToServer: side({
    requests: {
      state: request<void, CmdlessState>('state'),
      ui: request<Params, string>('ui'),
      connectionInfo: request<void, ConnectionInfo>('connectionInfo'),
      // asks main for a package's MCP server address - main serves its own
      // already-running instance directly if packageName is itself, or
      // resolves/spawns it (runAsMcp) if it's a sibling app.
      mcpAddress: request<{ packageName: string; version?: string }, { address: string }>('mcpAddress'),
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
  ipc: ReturnType<typeof cmdlessIPC.createClient>;
};