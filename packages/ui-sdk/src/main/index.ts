import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findPackageJSON } from "node:module";
import { execFileSync } from 'node:child_process';

export function getDefaultInstallPath() {
  return path.join(os.homedir(), '.cmdless', 'node', 'packages');
}

const decoder = new TextDecoder();
export async function getLatestPackageVersion(specifier: string) {
  const stdout = execFileSync("npm", ["view", specifier, "version"]);
  return decoder.decode(stdout).trim();
}

export async function getPrefix(parameters: PackageInstallParams) {
  //TODO: add support for {package}@{version}, splitting here
  const specifier = parameters.specifier;
  const installPath = parameters.installPath ?? getDefaultInstallPath();
  const version = parameters.version ?? await getLatestPackageVersion(specifier);
  const prefix = path.join(installPath, specifier, version);
  return { specifier, version, prefix };
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
  installPath?: string;
};

export async function ensurePackage(parameters: PackageInstallParams) {
  const { specifier, version, prefix } = await getPrefix(parameters);
  // installed packages always have node_modules as they must have a bin command
  if (!fs.existsSync(path.join(prefix, 'node_modules')))
    execFileSync("npm", ["install", "--prefix", prefix, `${specifier}@${version}`]);
  return { specifier, prefix };
}

export async function runAsPackage(parameters: PackageInstallParams, args: string[] = []) {
  const { specifier, prefix } = await ensurePackage(parameters);
  return execFileSync("npm", ["exec", "--prefix", prefix, `--package=${specifier}`, '--', ...args]);
}

export async function runAsRuntime(meta: ImportMeta, args: string[] = [], installPath?: string) {
  const version = await getMetaPackageVersion('@cmdless/ui-sdk', meta);
  return await runAsPackage({ specifier: '@cmdless/ui-runtime', version, installPath }, args);
}