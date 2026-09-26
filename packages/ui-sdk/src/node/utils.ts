import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findPackageJSON } from "node:module";
import { execFileSync } from 'node:child_process';
import * as types from '../types.js';

export function getEphemeralPrefix() {
  return '.cmdless.ui/';
}

export type BinResolve = { type: 'resolve'; value: unknown };
export type BinCleanup = { type: 'cleanup'; appName: string; userData: string };
export type BinMessage = BinResolve | BinCleanup;

export function binOutput<T>(value?: T) {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export class CmdlessEnv {
  static readonly ROOT_KEY = 'CMDLESS_ROOT';
  static readonly TOKEN_KEY = 'CMDLESS_TOKEN';
  static get root() { return process.env[CmdlessEnv.ROOT_KEY] ?? ''; }
  static get token() { return process.env[CmdlessEnv.TOKEN_KEY] ?? ''; }
  static set token(token: string) { process.env[CmdlessEnv.TOKEN_KEY] = token; }
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

export async function runAsPackage(parameters: PackageInstallParams, args: string[] = []) {
  const { packageName, prefix, cmdlessRoot } = await ensurePackage(parameters);
  const stdout = execFileSync("npm", ["exec", "--prefix", prefix, `--package=${packageName}`, '--', ...args], {
    env: {
      ...process.env,
      [CmdlessEnv.ROOT_KEY]: cmdlessRoot,
    }
  });
  return decoder.decode(stdout).trim();
}

export async function runAsRuntime(meta: ImportMeta, args: string[] = [], cmdlessRoot?: string) {
  const version = await getMetaPackageVersion('@cmdless/ui-sdk', meta);
  return await runAsPackage({ specifier: '@cmdless/ui-runtime', version, cmdlessRoot }, args);
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
          ...opt('address', parameters.address)
        ];
      case 'message-box':
        return [
          parameters.kind,
          parameters.type,
          parameters.message,
          ...opt('app', parameters.app)
        ];
      default: throw new Error(`Unsupported kind: ${JSON.stringify(parameters, null, 2)}`);
    }
  }
}