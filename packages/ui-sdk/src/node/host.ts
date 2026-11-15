import fs from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import { defineProtocol } from '@cmdless/rpc-sdk';
import { connectSocket } from '@cmdless/rpc-sdk/node';
import { getCmdlessUIVersion, runAsHost } from './utils.js';

// what a host hands back to whoever connects to it: what it reports through
// resolveService, to its own creator or (for one that lost the lock) a
// creator the lock holder answers instead
export type HostService = { address: string };

export type InitializeParams = {
  sdkVersion: string;
};

export type InitializeResult = {
  appName: string;
  userData: string;
  ephemeral: boolean;
  sdkVersion: string;
  // whether this connection owns the host: the one whose creator started the
  // process that got the app's lock. The host lives as long as it does.
  hasSingleInstanceLock: boolean;
};

const uiHostProtocol = defineProtocol(({ side, request }) => ({
  clientToServer: side({
    requests: {
      init: request<InitializeParams, InitializeResult>('init'),
    },
  }),
}));

export type UIServer = ReturnType<typeof UIHost.protocol.createServer>;
export type UIClient = ReturnType<typeof uiHostProtocol.createClient>;

export type CreateHostOptions = {
  // the app's name, which is Electron's single-instance lock: a host with
  // the same name is joined rather than started. Left out, the host is a
  // throwaway one of this caller's own.
  app?: string;
  cmdlessRoot?: string;
  // how long the host gets to start and report where it is
  timeoutMs?: number;
};

export class UIHost {
  static readonly protocol = uiHostProtocol;

  private constructor(readonly client: UIClient, readonly params: InitializeResult) { }

  static async create({ app, cmdlessRoot, timeoutMs }: CreateHostOptions = {}) {
    const { child, value } = await runAsHost<HostService>(import.meta, { app, cmdlessRoot, timeoutMs });
    const client = await connectSocket(uiHostProtocol, { path: value.address });
    client.listen();

    let params: InitializeResult;
    try {
      params = await client.request.init({ sdkVersion: await getCmdlessUIVersion(import.meta) });
    } catch (error) {
      client.dispose();
      throw error;
    }

    // a throwaway host's userData goes once its process is gone - only the
    // owner's creator started that process, so only it cleans up after it
    if (params.ephemeral && params.hasSingleInstanceLock) cleanUpAfter(child, params.userData);
    return new UIHost(client, params);
  }

  onClose(listener: () => void) {
    return this.client.onClose(listener);
  }

  dispose() {
    this.client.dispose();
  }
}

function cleanUpAfter(child: ChildProcess, userData: string) {
  child.once('exit', () => fs.rmSync(userData, { recursive: true, force: true }));
}
