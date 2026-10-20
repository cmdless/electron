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

// one app's own folder under the root, e.g. <root>/apps/hangar
export function getAppDataPath(app: string) {
  return path.join(getCmdlessRoot(), 'apps', app);
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

type ServiceMessage<T> =
  | { type: 'resolve'; value: T }
  | { type: 'reject'; error: string };

// sends one newline-delimited JSON message and waits for the other side to
// see it before tearing the socket down.
function sendOnce(socketPath: string, message: ServiceMessage<unknown>) {
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
  const socketPath = getTmpSocketPath(`cmdless-service-${crypto.randomUUID()}`);

  let received!: (message: ServiceMessage<T>) => void;
  const message = new Promise<ServiceMessage<T>>(resolve => received = resolve);
  const server = net.createServer(socket => {
    receiveOnce<T>(socket).then(received, error => received({ type: 'reject', error: String(error) }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const child = spawn(command, args, {
    stdio: 'ignore',
    windowsHide: true,
    ...spawnOptions,
    detached: true,
    env: { ...(spawnOptions.env ?? process.env), [SERVICE_SOCKET_KEY]: socketPath },
  });

  let timer: NodeJS.Timeout | undefined;
  const failures = new Promise<never>((_, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) =>
      reject(new Error(`${command} exited (${signal ?? code}) before resolving as a service`)));
    if (timeoutMs > 0)
      timer = setTimeout(() => reject(new Error(`${command} did not resolve as a service within ${timeoutMs}ms`)), timeoutMs);
  });

  try {
    const result = await Promise.race([message, failures]);
    if (result.type === 'reject') throw new Error(result.error);
    child.removeAllListeners('exit');
    child.removeAllListeners('error');
    child.unref();
    return { child, value: result.value };
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    throw error;
  } finally {
    clearTimeout(timer);
    server.close();
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
  return sendOnce(takeServiceSocket(), { type: 'resolve', value });
}

// reports a startup failure back to whoever is waiting, instead of leaving
// them to time out.
export function rejectService(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return sendOnce(takeServiceSocket(), { type: 'reject', error: message });
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

// what a daemon resolves as a service: only where to reach it
export type DaemonService = { address: string };

// connects to a running daemon, or starts it (from daemonPath) when nothing
// answers and connects to the address it resolves as a service. connect
// with no address tries the daemon's usual one.
export async function connectOrStart<T>(connect: (address?: string) => Promise<T>, daemonPath: string): Promise<T> {
  try {
    return await connect();
  } catch {
    const { value } = await waitForService<DaemonService>(process.execPath, [daemonPath]);
    return connect(value.address);
  }
}
