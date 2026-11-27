import path from 'node:path';
import { getMetaPackageVersion, resolvePackageBin, validCmdlessAppName } from '@cmdless/core/node';

const APP_KEY = 'CMDLESS_APP';
const URL_KEY = 'CMDLESS_URL';

export function getEphemeralPrefix() {
  return '.cmdless.ui/';
}

// what ui-runtime's host listens, reports and forwards with
export { getTmpSocketPath, listenOnce, sendTo, resolveService, rejectService } from '@cmdless/core/node';
// what @cmdless/ui's package command runs with
export { runAsPackage } from '@cmdless/core/node';
// what ui-runtime's launch commands set up and pass on with
export { acquireLock, getCmdlessRoot, resolveNewestPackageBin } from '@cmdless/core/node';

// the setters below write to this process's env by default, or - given an
// env to spawn with - only to a child's; an empty value removes the key.
function setEnv(key: string, value: string, env: NodeJS.ProcessEnv) {
  if (value) env[key] = value;
  else delete env[key];
}

// an app name as it's given: none, a throwaway one this package made, or an
// app's name (validCmdlessAppName) - anything else throws, since it names
// userData, the app's bundles and its single-instance lock
function checked(app: string) {
  return app === '' || isEphemeralCmdlessApp(app) ? app : validCmdlessAppName(app);
}

// the app name, which groups processes under one userData
export function getCmdlessApp() {
  return checked(process.env[APP_KEY] ?? '');
}

export function setCmdlessApp(app: string, env: NodeJS.ProcessEnv = process.env) {
  setEnv(APP_KEY, checked(app), env);
  return app;
}

export function resolveCmdlessApp() {
  return setCmdlessApp(getCmdlessApp() || `${getEphemeralPrefix()}${crypto.randomUUID()}`);
}

// this package's own version - what a host and the UIHosts connecting to it
// have to agree on
export function getCmdlessUIVersion() {
  return getMetaPackageVersion('@cmdless/ui-sdk', import.meta);
}

const EPHEMERAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// a throwaway app's name: the prefix, then the id it was made with - and
// nothing else
// ui-runtime's bin, at the version this package speaks: the local install
// when it's that version, or else that version installed into the cmdless
// root
export async function resolveRuntimeBin(cmdlessRoot?: string) {
  return resolvePackageBin(import.meta, '@cmdless/ui-runtime', await getCmdlessUIVersion(), cmdlessRoot);
}

export function isEphemeralCmdlessApp(appName: string) {
  const prefix = getEphemeralPrefix();
  return appName.startsWith(prefix) && EPHEMERAL_ID.test(appName.slice(prefix.length));
}

// whether a directory is an ephemeral app's userData: one named as an
// ephemeral app is, directly inside the ephemeral prefix's folder - wherever
// that folder is, and whatever separators the platform uses
export function isEphemeralUserData(userData: string) {
  if (!path.isAbsolute(userData)) return false;
  const resolved = path.resolve(userData);
  const folder = getEphemeralPrefix().replace(/[\\/]+$/, '');
  return path.basename(path.dirname(resolved)) === folder && EPHEMERAL_ID.test(path.basename(resolved));
}

// a dev server's URL, which a launcher shows instead of its built files
export function setCmdlessUrl(url: string, env: NodeJS.ProcessEnv = process.env) {
  setEnv(URL_KEY, url, env);
}

// deletes the env var once read, so a later process spawned down the line
// (which inherits process.env) doesn't also see it and keep swapping to it.
export function acquireCmdlessUrl() {
  const url = process.env[URL_KEY] ?? '';
  if (url) delete process.env[URL_KEY];
  return url;
}
