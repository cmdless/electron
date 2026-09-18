import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findPackageJSON } from "node:module";
import { execFileSync } from 'node:child_process';

export function getDefaultCmdlessRoot() {
  return process.env.CMDLESS_ROOT
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
  if (!fs.existsSync(path.join(prefix, 'node_modules')))
    execFileSync("npm", ["install", "--prefix", prefix, `${packageName}@${version}`]);
  return { packageName, prefix, cmdlessRoot };
}

export async function runAsPackage(parameters: PackageInstallParams, args: string[] = []) {
  const { packageName, prefix, cmdlessRoot } = await ensurePackage(parameters);
  return execFileSync("npm", ["exec", "--prefix", prefix, `--package=${packageName}`, '--', ...args], {
    env: {
      ...process.env,
      CMDLESS_ROOT: cmdlessRoot,
    }
  });
}

export async function runAsRuntime(meta: ImportMeta, args: string[] = [], cmdlessRoot?: string) {
  const version = await getMetaPackageVersion('@cmdless/ui-sdk', meta);
  return await runAsPackage({ specifier: '@cmdless/ui-runtime', version, cmdlessRoot }, args);
}