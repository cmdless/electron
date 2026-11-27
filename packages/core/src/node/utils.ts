import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { ChildProcess, SpawnOptions } from 'node:child_process';

const SERVICE_SOCKET_KEY = 'CMDLESS_SERVICE_SOCKET';
const ROOT_KEY = 'CMDLESS_ROOT';

// where everything cmdless keeps lives, unless CMDLESS_ROOT moves it
export function getCmdlessRoot() {
  return process.env[ROOT_KEY] || path.join(os.homedir(), '.cmdless');
}

// moves the root for this process, or - given an env to spawn with - for a
// child; an empty root goes back to the default
export function setCmdlessRoot(root: string, env: NodeJS.ProcessEnv = process.env) {
  if (root) env[ROOT_KEY] = root;
  else delete env[ROOT_KEY];
}

// An app's name has a package name's shape - an optional @scope/, then the
// name - in lowercase letters, digits and . _ ~ - (never first): one folder
// wherever it's joined (two, scoped), never . or .., and the same folder
// whatever a file system's case rules. It names locks and folders, so
// anything else is refused rather than cleaned up.
const APP_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;

export function isCmdlessAppName(name: string) {
  return name.length <= 214 && APP_NAME.test(name);
}

// the name, if it is one - throws saying what one is otherwise
export function validCmdlessAppName(name: string) {
  if (!isCmdlessAppName(name))
    throw new Error(`${JSON.stringify(name)} isn't an app name: [@scope/]name, in lowercase letters, digits and . _ ~ -`);
  return name;
}

// one app's own folder under the root, e.g. <root>/apps/hangar
export function getAppDataPath(app: string) {
  return path.join(getCmdlessRoot(), 'apps', validCmdlessAppName(app));
}

// Unix socket paths are capped (104 bytes on macOS, 108 on Linux), and
// macOS's per-user tmpdir alone eats about half of that - a name that would
// push the path past it is swapped for a short hash of itself.
const MAX_SOCKET_PATH = 100;

export function getTmpSocketPath(name: string) {
  if (process.platform === 'win32')
    return path.join('\\\\.\\pipe', `${name}.sock`);

  const socketPath = path.join(os.tmpdir(), `${name}.sock`);
  if (Buffer.byteLength(socketPath) <= MAX_SOCKET_PATH) return socketPath;
  const hash = createHash('sha256').update(name).digest('base64url').slice(0, 16);
  return path.join(os.tmpdir(), `${hash}.sock`);
}

export type ServiceMessage<T> =
  | { type: 'resolve'; value: T }
  | { type: 'reject'; error: string };

// sends one newline-delimited JSON message to a socket listenOnce handed
// out, and waits for the other side to see it before tearing the socket down
export function sendTo<T>(socketPath: string, message: ServiceMessage<T>) {
  return new Promise<void>((resolve, reject) => {
    const socket = net.createConnection(socketPath, () => socket.end(JSON.stringify(message) + '\n'));
    socket.once('error', reject);
    socket.once('close', () => resolve());
  });
}

// reads the first newline-delimited JSON message off a socket.
function receiveOnce<T>(socket: net.Socket) {
  return new Promise<ServiceMessage<T>>((resolve, reject) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      buffer += chunk;
      const pos = buffer.indexOf('\n');
      if (pos === -1) return;
      try { resolve(JSON.parse(buffer.slice(0, pos))); }
      catch (error) { reject(error); }
    });
    socket.once('error', reject);
  });
}

// listens on a fresh temporary socket for one message: the first one
// settles it (a reject message rejects it), a sender that hangs up without
// sending rejects it, and so does the timeout (0 waits forever). The socket
// closes once it's settled. `socketPath` is what's handed to the sender.
export async function listenOnce<T>(timeoutMs = 30_000) {
  const socketPath = getTmpSocketPath(`cmdless-once-${crypto.randomUUID()}`);
  let settle!: { resolve: (value: T) => void; reject: (error: unknown) => void };
  const message = new Promise<T>((resolve, reject) => settle = { resolve, reject });

  const server = net.createServer(socket => {
    receiveOnce<T>(socket).then(received => {
      if (received.type === 'resolve') settle.resolve(received.value);
      else settle.reject(new Error(received.error));
    }, settle.reject);
    socket.once('close', () => settle.reject(new Error('the sender hung up without sending')));
  });
  await listenOn(server, socketPath);

  const timer = timeoutMs > 0
    ? setTimeout(() => settle.reject(new Error(`nothing arrived within ${timeoutMs}ms`)), timeoutMs)
    : undefined;
  void message.catch(() => { }).finally(() => {
    clearTimeout(timer);
    server.close();
  });

  return { socketPath, message, close: (reason?: unknown) => settle.reject(reason ?? new Error('stopped listening')) };
}

export type WaitForServiceOptions = Omit<SpawnOptions, 'detached'> & {
  // how long to wait for resolveService before giving up; 0 waits forever
  timeoutMs?: number;
};

// spawns `command` detached and waits for it to call resolveService (or
// rejectService) - the spawned process decides on its own when it counts as
// started, and hands back whatever value it wants its caller to see (e.g.
// the address it listens on). The child is unref'd once it reports, so the
// caller can exit and leave it running. stdio defaults to 'ignore', since a
// detached service shouldn't keep writing into the caller's terminal.
export async function waitForService<T>(
  command: string,
  args: string[] = [],
  options: WaitForServiceOptions = {},
): Promise<{ child: ChildProcess; value: T }> {
  const { timeoutMs = 30_000, ...spawnOptions } = options;
  const once = await listenOnce<T>(timeoutMs);

  const child = spawn(command, args, {
    stdio: 'ignore',
    windowsHide: true,
    ...spawnOptions,
    detached: true,
    env: { ...(spawnOptions.env ?? process.env), [SERVICE_SOCKET_KEY]: once.socketPath },
  });

  const failed = new Promise<never>((_, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) =>
      reject(new Error(`${command} exited (${signal ?? code}) before resolving as a service`)));
  });

  try {
    const value = await Promise.race([once.message, failed]);
    child.removeAllListeners('exit');
    child.removeAllListeners('error');
    child.unref();
    return { child, value };
  } catch (error) {
    once.close(error);
    if (child.exitCode === null && child.signalCode === null) child.kill();
    throw error instanceof Error && error.message.startsWith('nothing arrived')
      ? new Error(`${command} did not resolve as a service within ${timeoutMs}ms`)
      : error;
  }
}

function takeServiceSocket() {
  const socketPath = process.env[SERVICE_SOCKET_KEY];
  if (!socketPath)
    throw new Error(`resolveService: no ${SERVICE_SOCKET_KEY} - was this process started by waitForService()?`);
  // so nothing this process spawns later thinks it was started as a service
  delete process.env[SERVICE_SOCKET_KEY];
  return socketPath;
}

// the spawned side of waitForService: reports `value` back to whoever is
// waiting, completing the loop. Throws when this process wasn't started by
// waitForService.
export function resolveService<T>(value: T) {
  return sendTo(takeServiceSocket(), { type: 'resolve', value });
}

// reports a startup failure back to whoever is waiting, instead of leaving
// them to time out.
export function rejectService(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return sendTo(takeServiceSocket(), { type: 'reject', error: message });
}

// true when this process was started by waitForService and hasn't reported yet
export function isPendingService() {
  return !!process.env[SERVICE_SOCKET_KEY];
}

function listenOn(server: net.Server, socketPath: string) {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => { server.off('listening', onListening); reject(error); };
    const onListening = () => {
      server.off('error', onError);
      // only this user may connect - a named pipe on Windows keeps its
      // default access, which this doesn't tighten
      if (process.platform !== 'win32') fs.chmodSync(socketPath, 0o600);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(socketPath);
  });
}

// listens on a named socket only if nothing else is - the socket is the
// lock, so a daemon that gets it is the only one. Resolves false when a live
// process already holds it. A Unix socket outlives a crashed process as a
// file nothing listens on, so a refused connection means it's stale and safe
// to replace; a named pipe on Windows goes away with its process.
export async function listenExclusive(server: net.Server, socketPath: string): Promise<boolean> {
  try {
    await listenOn(server, socketPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
  }

  const live = await new Promise<boolean>((resolve, reject) => {
    const probe = net.createConnection(socketPath, () => { probe.end(); resolve(true); });
    probe.once('error', error => {
      if ((error as NodeJS.ErrnoException).code === 'ECONNREFUSED') resolve(false);
      else reject(error);
    });
  });
  if (live) return false;

  fs.rmSync(socketPath, { force: true });
  await listenOn(server, socketPath);
  return true;
}

// whether connecting failed because no daemon is there to answer - no
// socket, or a stale one nothing listens on
export function nothingAnswers(error: unknown) {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === 'ENOENT' || code === 'ECONNREFUSED';
}

// what a daemon resolves as a service: only where to reach it
export type DaemonService = { address: string };

// connects to a running daemon, or starts it (from daemonPath) when nothing
// answers and connects to the address it resolves as a service. connect
// with no address tries the daemon's usual one.
export async function connectOrStart<T>(connect: (address?: string) => Promise<T>, daemonPath: string): Promise<T> {
  try {
    return await connect();
  } catch (error) {
    // only "nothing is there" starts one - anything else (a daemon that
    // answered but won't do, say) is the caller's to see
    if (!nothingAnswers(error)) throw error;
    const { value } = await waitForService<DaemonService>(process.execPath, [daemonPath]);
    return connect(value.address);
  }
}
