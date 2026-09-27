import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findPackageJSON } from "node:module";
import { execFileSync, spawn } from 'node:child_process';
import * as types from '../types.js';
import { defineProtocol, RpcProtocol } from '@cmdless/rpc-sdk';
import { startWebSocket, closeWebSocketServer, getWebSocketUrl } from '@cmdless/rpc-sdk/ws/node';
import { startSocket, connectSocket } from '@cmdless/rpc-sdk/node';

export function getEphemeralPrefix() {
  return '.cmdless.ui/';
}

export function getTmpSocketPath(app: string) {
  const pipeName = `${app}.sock`;
  return process.platform === 'win32'
    ? path.join('\\\\.\\pipe', pipeName)
    : path.join(os.tmpdir(), pipeName);
}

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
  static readonly SOCKET_KEY = 'CMDLESS_BIN_SOCKET';

  static async start(onMessage: (message: BinMessage) => void) {
    const socketPath = getTmpSocketPath(crypto.randomUUID());
    const server = await startSocket({
      protocol: binProtocol,
      options: { path: socketPath },
      configure: peer => peer.onNotification.message(onMessage),
    });

    return {
      env: { ...process.env, [BinChannel.SOCKET_KEY]: socketPath },
      close: () => new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
      }),
    };
  }

  static async connect(): Promise<(message: BinMessage) => void> {
    const socketPath = process.env[BinChannel.SOCKET_KEY];
    if (socketPath) delete process.env[BinChannel.SOCKET_KEY];
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

export class CmdlessEnv {
  static readonly ROOT_KEY = 'CMDLESS_ROOT';
  static readonly APP_KEY = 'CMDLESS_APP';
  static readonly URL_KEY = 'CMDLESS_URL';
  static get root() { return process.env[CmdlessEnv.ROOT_KEY] ?? ''; }
  static get app() { return process.env[CmdlessEnv.APP_KEY] ?? ''; }
  static set app(app: string) { process.env[CmdlessEnv.APP_KEY] = app; }
  static get url() { return process.env[CmdlessEnv.URL_KEY] ?? ''; }
  static set url(url: string) { process.env[CmdlessEnv.URL_KEY] = url; }
}

// deletes the env var once read, so a later process spawned down the line
// (which inherits process.env) doesn't also see it and keep swapping to it.
export function acquireCmdlessUrl() {
  const url = CmdlessEnv.url;
  if (url) delete process.env[CmdlessEnv.URL_KEY];
  return url;
}

export function getDefaultCmdlessRoot() {
  return CmdlessEnv.root
    ?? path.join(os.homedir(), '.cmdless');
}

export function getInstallPath(cmdlessRoot: string) {
  return path.join(cmdlessRoot, 'node', 'packages');
}

const decoder = new TextDecoder();
export async function getLatestPackageVersion(packageName: string) {
  const stdout = execFileSync("npm", ["view", packageName, "version"]);
  return decoder.decode(stdout).trim();
}

export function getPackageName(specifier: string) {
  const lastAtIndex = specifier.lastIndexOf("@");
  if (lastAtIndex > 0) {
    const packageName = specifier.substring(0, lastAtIndex);
    const packageVersion = specifier.substring(lastAtIndex + 1);

    // "latest" is a moving target, not a real pinned version - treat it as
    // if no version was given at all, so it resolves (and caches) for real.
    if (packageVersion.toLowerCase() === 'latest')
      return { packageName };

    return { packageName, packageVersion };
  }
  return { packageName: specifier };
}

export async function getPrefix(parameters: PackageInstallParams) {
  const { packageName, packageVersion } = getPackageName(parameters.specifier);
  const cmdlessRoot = parameters.cmdlessRoot ?? getDefaultCmdlessRoot();
  const installPath = getInstallPath(cmdlessRoot);
  const version = packageVersion ?? parameters.version ?? await getLatestPackageVersion(packageName);
  const prefix = path.join(installPath, packageName, version);
  return { packageName, version, prefix, cmdlessRoot };
}

export async function getMetaPackageVersion(specifier: string, meta: ImportMeta) {
  const packagePath = findPackageJSON(specifier, meta.url);
  if (!packagePath)
    throw new Error(`package.json for package ${specifier} not found at ${meta.url}`);
  const pkg = JSON.parse(await fs.promises.readFile(packagePath, 'utf8'));
  return pkg.version as string;
}

export function findLocalBinPath(packageName: string, meta: ImportMeta): string | null {
  const packagePath = findPackageJSON(packageName, meta.url);
  if (!packagePath) return null;

  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const bin = typeof pkg.bin === 'string' ? pkg.bin : Object.values(pkg.bin ?? {})[0];
  if (typeof bin !== 'string') return null;

  return path.join(path.dirname(packagePath), bin);
}

export type PackageInstallParams = {
  specifier: string;
  version?: string;
  cmdlessRoot?: string;
};

export async function ensurePackage(parameters: PackageInstallParams) {
  const { packageName, version, prefix, cmdlessRoot } = await getPrefix(parameters);
  if (!fs.existsSync(path.join(prefix, 'node_modules', packageName, 'package.json')))
    execFileSync("npm", ["install", "--prefix", prefix, `${packageName}@${version}`]);
  return { packageName, prefix, cmdlessRoot };
}

function execPackageEnv(cmdlessRoot?: string): NodeJS.ProcessEnv {
  return { ...process.env, ...(cmdlessRoot ? { [CmdlessEnv.ROOT_KEY]: cmdlessRoot } : {}) };
}

function execPackageArgs(packageName: string, prefix: string, args: string[]) {
  return ["exec", "--prefix", prefix, `--package=${packageName}`, '--', ...args];
}

// forwards SIGINT/SIGTERM to `child` - without this, killing *this* process
// while `child` is a long-running interactive app (e.g. Electron) leaves it
// orphaned, since nothing ever tells it to close. Uses `.on`, not `.once`:
// a real Ctrl+C delivers the signal to every process in the group at once,
// *and* each level explicitly re-forwards it to its own child - so a child
// two levels down gets hit twice, and a `.once` listener would revert to
// Node's default (immediate, ungraceful) termination on the second delivery.
function forwardSignals(child: import('node:child_process').ChildProcess) {
  const forward = (signal: NodeJS.Signals) => child.kill(signal);
  process.on('SIGINT', forward);
  process.on('SIGTERM', forward);
  child.once('exit', () => {
    process.off('SIGINT', forward);
    process.off('SIGTERM', forward);
  });
}

// unlike execFileSync, this doesn't block the event loop for the process's
// whole lifetime - needed so forwardSignals (and anything else this process
// wants to do concurrently) can actually run while `command` is alive.
function execProcess(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['inherit', 'pipe', 'inherit'] });
    forwardSignals(child);
    const chunks: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.once('error', reject);
    child.once('exit', code => {
      if (code !== 0) reject(new Error(`${command} exited with code ${code}`));
      else resolve(Buffer.concat(chunks).toString('utf8').trim());
    });
  });
}

export async function runPackage(packageName: string, prefix: string, args: string[] = [], cmdlessRoot?: string) {
  return execProcess("npm", execPackageArgs(packageName, prefix, args), execPackageEnv(cmdlessRoot));
}

// unlike runPackage, this is for a long-running process (e.g. an Electron
// app) - it hands back the live child instead of waiting on it to exit.
export function spawnPackage(packageName: string, prefix: string, args: string[] = [], env: NodeJS.ProcessEnv = process.env) {
  return spawn("npm", execPackageArgs(packageName, prefix, args), { stdio: 'inherit', env });
}

export async function runAsPackage(parameters: PackageInstallParams, args: string[] = []) {
  const { packageName, prefix, cmdlessRoot } = await ensurePackage(parameters);
  return runPackage(packageName, prefix, args, cmdlessRoot);
}

export async function runAsRuntime(meta: ImportMeta, args: string[] = [], cmdlessRoot?: string) {
  const specifier = '@cmdless/ui-runtime';
  const binPath = findLocalBinPath(specifier, meta);
  if (binPath) {
    const root = cmdlessRoot ?? getDefaultCmdlessRoot();
    return execProcess(process.execPath, [binPath, ...args], execPackageEnv(root));
  }
  const version = await getMetaPackageVersion('@cmdless/ui-sdk', meta);
  return await runAsPackage({ specifier, version, cmdlessRoot }, args);
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

export function createShowCommand<In = void, Out = string, P extends RpcProtocol = RpcProtocol>(config: {
  params: (input: In) => Omit<types.ShowParams, 'kind' | 'address' | 'parent'>;
  result?: (input: In, stdout: string) => Out;
  dispatcher?: CmdlessUIDispatcher;
  cmdlessRoot?: string;
  transport?: (input: In, parameters: types.ShowParams) => Parameters<typeof startWebSocket<P>>[0];
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
    // CmdlessEnv.url - when present, it always wins over whatever params()
    // returned, so individual show commands never have to check for it.
    const url = acquireCmdlessUrl();
    if (url) {
      parameters.type = 'url';
      parameters.source = url;
    }

    const server = transport ? await startWebSocket<P>(transport(input, parameters)) : undefined;
    try {
      if (server) {
        const address = getWebSocketUrl(server);
        parameters.address = address;
      }

      const stdout = await new CmdlessUI(dispatcher, cmdlessRoot).show(parameters);
      return result(input, stdout);
    } finally {
      if (server)
        await closeWebSocketServer(server).catch(console.error);
    }
  };
}