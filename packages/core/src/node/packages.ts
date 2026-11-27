import fs from 'node:fs';
import path from 'node:path';
import { findPackageJSON } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import { getCmdlessRoot, setCmdlessRoot } from './utils.js';

// running npm packages from wherever they are: the local install when
// there is one, or else a version installed into the cmdless root

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
  const cmdlessRoot = parameters.cmdlessRoot ?? getCmdlessRoot();
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

export function resolveBinFromPackageJson(packagePath: string): string | null {
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const bin = typeof pkg.bin === 'string' ? pkg.bin : Object.values(pkg.bin ?? {})[0];
  if (typeof bin !== 'string') return null;

  return path.join(path.dirname(packagePath), bin);
}

// a package's package.json as meta would import it - nothing, rather than a
// throw, when meta can't see it
function findPackage(packageName: string, meta: ImportMeta) {
  try {
    return findPackageJSON(packageName, meta.url);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND') return undefined;
    throw error;
  }
}

export function findLocalBinPath(packageName: string, meta: ImportMeta): string | null {
  const packagePath = findPackage(packageName, meta);
  if (!packagePath) return null;
  return resolveBinFromPackageJson(packagePath);
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

export function packageEnv(cmdlessRoot?: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (cmdlessRoot) setCmdlessRoot(cmdlessRoot, env);
  return env;
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
export function forwardSignals(child: import('node:child_process').ChildProcess) {
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
// runs a command to completion and resolves with its output. Aborting the
// signal stops it (SIGTERM) and rejects with the signal's reason.
export function execProcess(command: string, args: string[], env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const child = spawn(command, args, { env, stdio: ['inherit', 'pipe', 'inherit'] });
    forwardSignals(child);
    const abort = () => { child.kill('SIGTERM'); reject(signal!.reason); };
    signal?.addEventListener('abort', abort, { once: true });
    child.once('exit', () => signal?.removeEventListener('abort', abort));
    const chunks: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.once('error', reject);
    child.once('exit', code => {
      if (code !== 0) reject(new Error(`${command} exited with code ${code}`));
      else resolve(Buffer.concat(chunks).toString('utf8').trim());
    });
  });
}

export async function runPackage(packageName: string, prefix: string, args: string[] = [], cmdlessRoot?: string, signal?: AbortSignal) {
  return execProcess("npm", execPackageArgs(packageName, prefix, args), packageEnv(cmdlessRoot), signal);
}

// unlike runPackage, this is for a long-running process (e.g. an Electron
// app) - it hands back the live child instead of waiting on it to exit.
export function spawnPackage(packageName: string, prefix: string, args: string[] = [], env: NodeJS.ProcessEnv = process.env) {
  return spawn("npm", execPackageArgs(packageName, prefix, args), { stdio: 'inherit', env });
}

export async function runAsPackage(parameters: PackageInstallParams, args: string[] = [], signal?: AbortSignal) {
  const { packageName, prefix, cmdlessRoot } = await ensurePackage(parameters);
  return runPackage(packageName, prefix, args, cmdlessRoot, signal);
}

// the local install's bin, if meta can see one - and, given a version, only
// if it's that version
function localBin(packageName: string, meta: ImportMeta, version?: string) {
  const packagePath = findPackage(packageName, meta);
  if (!packagePath) return null;
  if (version !== undefined && JSON.parse(fs.readFileSync(packagePath, 'utf8')).version !== version) return null;
  return resolveBinFromPackageJson(packagePath);
}

// resolves `packageName`'s bin locally first - when it's the version asked
// for, if one is - falling back to ensurePackage's cache.
export async function resolvePackageBin(meta: ImportMeta, packageName: string, version?: string, cmdlessRoot?: string) {
  const localBinPath = localBin(packageName, meta, version);
  if (localBinPath) return { binPath: localBinPath, env: packageEnv(cmdlessRoot) };

  const { prefix, cmdlessRoot: root } = await ensurePackage({ specifier: packageName, version, cmdlessRoot });
  const resolved = resolveBinFromPackageJson(path.join(prefix, 'node_modules', packageName, 'package.json'));
  if (!resolved) throw new Error(`package ${packageName} has no "bin" entry`);
  return { binPath: resolved, env: packageEnv(root) };
}

// compares two versions, x.y.z[-pre]: a prerelease comes before its release
export function compareVersions(a: string, b: string) {
  const parse = (version: string) => {
    const [release, pre] = version.split('-', 2);
    return { parts: release.split('.').map(Number), pre };
  };
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < Math.max(x.parts.length, y.parts.length); i++) {
    const difference = (x.parts[i] ?? 0) - (y.parts[i] ?? 0);
    if (difference) return Math.sign(difference);
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  // a prerelease's parts: numbers by number, and before words
  const [p, q] = [x.pre.split('.'), y.pre.split('.')];
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    if (p[i] === undefined) return -1;
    if (q[i] === undefined) return 1;
    const [m, n] = [/^\d+$/.test(p[i]), /^\d+$/.test(q[i])];
    if (m && n && Number(p[i]) !== Number(q[i])) return Math.sign(Number(p[i]) - Number(q[i]));
    if (m !== n) return m ? -1 : 1;
    if (p[i] !== q[i]) return p[i] < q[i] ? -1 : 1;
  }
  return 0;
}

// the newest version of a package already installed into the cmdless root,
// if any is
export function newestCachedVersion(packageName: string, cmdlessRoot = getCmdlessRoot()) {
  const folder = path.join(getInstallPath(cmdlessRoot), packageName);
  const versions = fs.existsSync(folder)
    ? fs.readdirSync(folder).filter(version => fs.existsSync(path.join(folder, version, 'node_modules', packageName, 'package.json')))
    : [];
  return versions.sort(compareVersions).at(-1);
}

// resolves `packageName`'s bin locally first, then the newest version
// already cached - asking npm for the latest, and installing it, only when
// none is. Nothing here updates what's cached: whatever's there runs.
export async function resolveNewestPackageBin(meta: ImportMeta, packageName: string, cmdlessRoot?: string) {
  const local = localBin(packageName, meta);
  if (local) return { binPath: local, env: packageEnv(cmdlessRoot) };
  return resolvePackageBin(meta, packageName, newestCachedVersion(packageName, cmdlessRoot), cmdlessRoot);
}

export type SpawnAsPackageOptions = {
  version?: string;
  cmdlessRoot?: string;
};

// resolves packageName via resolvePackageBin, then spawns its bin directly
// with piped stdio, for a long-running process you need to stream to/from
// (e.g. an ACP agent's JSON-RPC-over-stdio) - unlike spawnPackage (stdio
// inherited from this process, e.g. Electron) or runPackage/runAsPackage
// (blocking, captures output only once the process exits).
export async function spawnAsPackage(meta: ImportMeta, packageName: string, args: string[] = [], options: SpawnAsPackageOptions = {}) {
  const { binPath, env } = await resolvePackageBin(meta, packageName, options.version, options.cmdlessRoot);
  const child = spawn(process.execPath, [binPath, ...args], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  forwardSignals(child);
  return child;
}


export type PackageExportOptions = {
  version?: string;
  cmdlessRoot?: string;
};

// a file a package exports (say its './daemon'), as a path: from the local
// install when meta can see one, or else from `version` installed into the
// cmdless root
export async function resolvePackageExport(meta: ImportMeta, packageName: string, subpath: string, options: PackageExportOptions = {}) {
  const packagePath = findPackage(packageName, meta)
    ?? path.join((await ensurePackage({ specifier: packageName, ...options })).prefix, 'node_modules', packageName, 'package.json');

  const exported = JSON.parse(fs.readFileSync(packagePath, 'utf8')).exports?.[subpath];
  const target = typeof exported === 'string' ? exported : exported?.import ?? exported?.default;
  if (typeof target !== 'string') throw new Error(`${packageName} doesn't export ${subpath}`);
  return path.join(path.dirname(packagePath), target);
}
