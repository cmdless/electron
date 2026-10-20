import fs from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { SpawnOptions } from 'node:child_process';
import * as types from '../types.js';
import { defineProtocol } from '@cmdless/rpc-sdk';
import type { MaybePromise, TransportParameters } from '@cmdless/rpc-sdk';
import type { ServerOptions, VerifyClientCallbackAsync, VerifyClientCallbackSync } from 'ws';
import { startWebSocket, closeWebSocketServer, getWebSocketUrl } from '@cmdless/rpc-sdk/ws/node';
import { startSocket, connectSocket } from '@cmdless/rpc-sdk/node';
import {
  execProcess, findLocalBinPath, forwardSignals, getCmdlessRoot, getMetaPackageVersion, getTmpSocketPath,
  packageEnv, resolvePackageBin, runAsPackage,
} from '@cmdless/core/node';
import type { McpHandle } from './app.js';

const APP_KEY = 'CMDLESS_APP';
const URL_KEY = 'CMDLESS_URL';
const BIN_SOCKET_KEY = 'CMDLESS_BIN_SOCKET';

export function getEphemeralPrefix() {
  return '.cmdless.ui/';
}

export { getTmpSocketPath, getCmdlessRoot, setCmdlessRoot } from '@cmdless/core/node';
// the package helpers live in core now; these keep ui-sdk's own exports working
export {
  ensurePackage, findLocalBinPath, getInstallPath, getLatestPackageVersion, getMetaPackageVersion, getPackageName,
  getPrefix, runAsPackage, runPackage, spawnAsPackage, spawnPackage,
} from '@cmdless/core/node';
export type { PackageInstallParams, SpawnAsPackageOptions } from '@cmdless/core/node';

export type BinResolve = { type: 'resolve'; value: unknown };
export type BinCleanup = { type: 'cleanup'; appName: string; userData: string };
export type BinMessage = BinResolve | BinCleanup;

const binProtocol = defineProtocol(({ side, notification }) => ({
  clientToServer: side({
    notifications: {
      message: notification<BinMessage>('message'),
    },
  }),
}));

// A bin (e.g. ui-runtime's) spawns a long-running child (e.g. Electron) and
// needs it to report back a resolved value and an ephemeral-userData cleanup
// signal. Node's own child_process 'ipc' stdio channel is a well-documented
// source of Electron init hangs when combined with app.whenReady() (see
// electron/electron#17044), so this uses a plain local socket instead: the
// parent calls start() before spawning (folding the socket path into the
// child's env), and the child calls connect() to get a send function back.
export class BinChannel {
  static async start(onMessage: (message: BinMessage) => void) {
    const socketPath = getTmpSocketPath(crypto.randomUUID());
    const { accept } = await binProtocol.defineHost({
      configure: peer => peer.onNotification.message(onMessage),
    })();
    const server = await startSocket({ accept, options: { path: socketPath } });

    return {
      env: { ...process.env, [BIN_SOCKET_KEY]: socketPath },
      close: () => new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
      }),
    };
  }

  static async connect(): Promise<(message: BinMessage) => void> {
    const socketPath = process.env[BIN_SOCKET_KEY];
    if (socketPath) delete process.env[BIN_SOCKET_KEY];
    if (!socketPath)
      throw new Error('BinChannel.connect: no socket to connect to (missing CMDLESS_BIN_SOCKET) - was this launched via BinChannel.start()?');

    const peer = await connectSocket(binProtocol, { path: socketPath });
    peer.listen();
    return message => peer.notify.message(message);
  }
}

export function binOutput<T>(value?: T) {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export type RunAsBinOptions = Omit<SpawnOptions, 'stdio'>;

// spawns `command` as a bin that reports back over BinChannel (e.g.
// ui-runtime's Electron child), hiding the whole dance: wiring the socket
// into its env, cleaning up the ephemeral userData dir once it's reported,
// forwarding signals, and tearing the channel down on exit. stdio is fixed
// (no 'ipc' slot - see BinChannel's own comment), so it's the one thing
// callers can't override. Resolves to the resolved value, formatted via
// binOutput ('' if the child never resolved one) - it's handed back rather
// than written to this process's own stdout, since stdout is a *bin* file's
// concept (its own caller expects it there), not something every runAsBin
// caller wants: a programmatic caller just wants the value.
export async function runAsBin(command: string, args: string[], opts: RunAsBinOptions = {}): Promise<string> {
  let cleanupUserData: string | undefined;
  let output = '';
  const channel = await BinChannel.start(message => {
    if (message.type === 'cleanup') {
      cleanupUserData = message.userData;
      return;
    }
    if (message.value !== null) output = binOutput(message.value);
  });

  const socketPath = channel.env[BIN_SOCKET_KEY];
  const env = { ...(opts.env ?? process.env), [BIN_SOCKET_KEY]: socketPath };
  const child = spawn(command, args, { ...opts, env, stdio: ['inherit', 'pipe', 'inherit'] });
  child.stdout?.pipe(process.stderr);
  forwardSignals(child);

  return new Promise<string>((resolve, reject) => {
    child.once('exit', code => {
      if (cleanupUserData) fs.rmSync(cleanupUserData, { recursive: true, force: true });
      process.exitCode = code ?? 1;
      channel.close().catch(() => { });
      resolve(output);
    });
    child.once('error', reject);
  });
}

// the setters below write to this process's env by default, or - given an
// env to spawn with - only to a child's; an empty value removes the key.
function setEnv(key: string, value: string, env: NodeJS.ProcessEnv) {
  if (value) env[key] = value;
  else delete env[key];
}

// the app name, which groups processes under one userData
export function getCmdlessApp() {
  return process.env[APP_KEY] ?? '';
}

export function setCmdlessApp(app: string, env: NodeJS.ProcessEnv = process.env) {
  setEnv(APP_KEY, app, env);
}

// a dev server's URL, which createShowCommand shows instead of params()'s
export function getCmdlessUrl() {
  return process.env[URL_KEY] ?? '';
}

export function setCmdlessUrl(url: string, env: NodeJS.ProcessEnv = process.env) {
  setEnv(URL_KEY, url, env);
}

// deletes the env var once read, so a later process spawned down the line
// (which inherits process.env) doesn't also see it and keep swapping to it.
export function acquireCmdlessUrl() {
  const url = getCmdlessUrl();
  if (url) delete process.env[URL_KEY];
  return url;
}

export async function runAsRuntime(meta: ImportMeta, args: string[] = [], cmdlessRoot?: string) {
  const specifier = '@cmdless/ui-runtime';
  const binPath = findLocalBinPath(specifier, meta);
  if (binPath) {
    const root = cmdlessRoot ?? getCmdlessRoot();
    return execProcess(process.execPath, [binPath, ...args], packageEnv(root));
  }
  const version = await getMetaPackageVersion('@cmdless/ui-sdk', meta);
  return await runAsPackage({ specifier, version, cmdlessRoot }, args);
}

// runs its `mcp` command. Unlike runAsRuntime, there's no Electron involved
// here - just a plain node process - so the child_process 'ipc' channel is
// safe to use to get its address back, unlike the 'ipc' + Electron
// combination that causes app.whenReady() hangs elsewhere in this codebase
// (see BinChannel's own comment).
export async function runAsMcp(meta: ImportMeta, packageName: string, version?: string, cmdlessRoot?: string): Promise<McpHandle> {
  const { binPath, env } = await resolvePackageBin(meta, packageName, version, cmdlessRoot);

  const child = spawn(process.execPath, [binPath, 'mcp'], { env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });

  const address = await new Promise<string>((resolve, reject) => {
    child.once('message', (message: unknown) => {
      const address = (message as { address?: string } | null)?.address;
      if (address) resolve(address);
      else reject(new Error(`${packageName}'s mcp command reported an invalid message`));
    });
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`${packageName}'s mcp command exited before reporting an address (code ${code})`)));
  });

  const dispose = () => new Promise<void>(resolve => {
    child.once('exit', () => resolve());
    child.kill();
  });

  return { address, dispose };
}

type CmdlessUIDispatcher = (parameters: types.Params, cmdlessRoot?: string) => Promise<string>;
const runtimeDispatcher: CmdlessUIDispatcher = (parameters: types.Params, cmdlessRoot?: string) => {
  return runAsRuntime(import.meta, CmdlessUI.toArgs(parameters), cmdlessRoot);
};

export class CmdlessUI {
  constructor(
    private readonly dispatch: CmdlessUIDispatcher = runtimeDispatcher,
    private readonly cmdlessRoot?: string
  ) { }

  async show(parameters: types.ShowParams) {
    const output = await this.dispatch(parameters, this.cmdlessRoot);
    return output;
  }

  async messageBox(parameters: types.MessageBoxParams) {
    const output = await this.dispatch(parameters, this.cmdlessRoot);
    return output;
  }

  run(parameters: types.Params) {
    switch (parameters.kind) {
      case 'show': return this.show(parameters);
      case 'message-box': return this.messageBox(parameters);
      default: throw new Error(`Unsupported kind: ${JSON.stringify(parameters, null, 2)}`);
    }
  }

  static toArgs(parameters: types.Params): string[] {
    const opt = <T>(name: string, value?: T) => value !== undefined ? [`--${name}`, `${value}`] : [];
    switch (parameters.kind) {
      case 'show':
        return [
          parameters.kind,
          parameters.type,
          parameters.source,
          ...opt('app', parameters.app),
          ...opt('width', parameters.width),
          ...opt('height', parameters.height),
          ...opt('address', parameters.address),
          ...opt('redirect', parameters.redirect),
          ...opt('parent', parameters.parent)
        ];
      case 'message-box':
        return [
          parameters.kind,
          parameters.type,
          parameters.message,
          ...opt('app', parameters.app),
          ...opt('parent', parameters.parent)
        ];
      default: throw new Error(`Unsupported kind: ${JSON.stringify(parameters, null, 2)}`);
    }
  }
}

// wraps a transport's WebSocket so it only admits connections presenting
// ?token=<token>, ahead of any verifyClient the transport set itself
function requireToken(parameters: TransportParameters<ServerOptions>, token: string): TransportParameters<ServerOptions> {
  const presents = (url = '') => {
    const presented = new URL(url, 'ws://window').searchParams.get('token') ?? '';
    return presented.length === token.length && timingSafeEqual(Buffer.from(presented), Buffer.from(token));
  };
  const own = parameters.options?.verifyClient;
  const verifyClient: VerifyClientCallbackSync | VerifyClientCallbackAsync = own && own.length >= 2
    ? (info, done) => presents(info.req.url) ? (own as VerifyClientCallbackAsync)(info, done) : done(false, 401)
    : (info: Parameters<VerifyClientCallbackSync>[0]) => presents(info.req.url) && (own ? (own as VerifyClientCallbackSync)(info) : true);
  return { ...parameters, options: { ...parameters.options, verifyClient } };
}

export function createShowCommand<In = void, Out = string>(config: {
  params: (input: In) => Omit<types.ShowParams, 'kind' | 'address' | 'parent'>;
  result?: (input: In, stdout: string) => Out;
  dispatcher?: CmdlessUIDispatcher;
  cmdlessRoot?: string;
  transport?: (input: In, parameters: types.ShowParams) => MaybePromise<TransportParameters<ServerOptions>>;
}) {
  return async (input: In, parent?: number): Promise<Out> => {
    const {
      params,
      result = (_, stdout) => stdout as Out,
      dispatcher,
      cmdlessRoot,
      transport,
    } = config;

    const parameters: types.ShowParams = {
      kind: 'show',
      ...params(input),
      parent,
    };

    // a dev server (e.g. a vite plugin) can publish its own URL under
    // setCmdlessUrl - when present, it always wins over whatever params()
    // returned, so individual show commands never have to check for it.
    // params()'s own source may carry a hash route (e.g. for a single-page
    // renderer with multiple top-level views) - that's preserved onto the
    // dev URL too, so routing works the same whether it's the built file or
    // the dev server.
    const url = acquireCmdlessUrl();
    if (url) {
      const hashIndex = parameters.source.indexOf('#');
      const hash = hashIndex >= 0 ? parameters.source.slice(hashIndex) : '';
      parameters.type = 'url';
      parameters.source = url + hash;
    }

    // anything on this machine can reach a loopback port, a web page in a
    // browser included - so the window's connection requires a token, handed
    // to it inside the address it's given
    const token = randomBytes(24).toString('base64url');
    const server = transport ? await startWebSocket(requireToken(await transport(input, parameters), token)) : undefined;
    try {
      if (server)
        parameters.address = `${getWebSocketUrl(server)}/?token=${token}`;

      const stdout = await new CmdlessUI(dispatcher, cmdlessRoot).show(parameters);
      return result(input, stdout);
    } finally {
      if (server)
        await closeWebSocketServer(server).catch(console.error);
    }
  };
}