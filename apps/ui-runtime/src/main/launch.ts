// The launcher: .cmdless files, opened from Finder (or wherever the platform
// opens files from), run through this runtime's own bin - `launch open` - by
// way of a shim set up once per machine. What a file says to do is
// @cmdless/launch-tray's business: add and open make sure the shim is there,
// read the file, and hand its launch to the tray through LaunchHost.

import fs from 'node:fs';
import path from 'node:path';
import { parseLaunch } from '@cmdless/ui-sdk';
import { acquireLock, getCmdlessRoot } from '@cmdless/ui-sdk/node';
import { installLinux, linuxInstalled } from './launch-linux.js';
import { installMacOS, macOSInstalled } from './launch-macos.js';
import { installWindows, windowsInstalled } from './launch-windows.js';

// what the shim runs, the root it runs with when one was set
// (CMDLESS_ROOT), and the shape of the shim itself - a newer shape is set up
// again over the old one
export type Launcher = { shim: number; node: string; bin: string; version: string; root: string | null };
const SHIM = 1;

// where the launcher keeps its shim and what it runs
export const launchRoot = () => path.join(getCmdlessRoot(), 'launch');
const launcherFile = () => path.join(launchRoot(), 'launcher.json');

const sameLauncher = (a: Launcher, b: Launcher) =>
  a.shim === b.shim && a.node === b.node && a.bin === b.bin && a.version === b.version && a.root === (b.root ?? null);

function recorded(): Launcher | undefined {
  try {
    return JSON.parse(fs.readFileSync(launcherFile(), 'utf8'));
  } catch {
    return undefined;
  }
}

function platformInstall() {
  switch (process.platform) {
    case 'darwin': return { install: installMacOS, installed: macOSInstalled };
    // drafts, not yet tested on their platforms
    case 'win32': return { install: installWindows, installed: windowsInstalled };
    case 'linux': return { install: installLinux, installed: linuxInstalled };
    default: throw new Error(`the launcher isn't set up on ${process.platform} yet`);
  }
}

// Makes sure the shim runs this node and this bin, setting it up again if
// anything about it differs - once, whoever else is doing the same. True if
// it was set up now.
export async function ensureLauncher(version: string) {
  const wanted: Launcher = {
    shim: SHIM, node: process.execPath, bin: fs.realpathSync(process.argv[1]), version,
    root: process.env.CMDLESS_ROOT || null,
  };
  const platform = platformInstall();
  const current = () => {
    const found = recorded();
    return found !== undefined && sameLauncher(found, wanted) && platform.installed(launchRoot());
  };
  if (current()) return false;

  const release = await acquireLock('cmdless-launch-install');
  try {
    if (current()) return false;
    fs.mkdirSync(launchRoot(), { recursive: true });
    await platform.install(launchRoot(), wanted);
    fs.writeFileSync(launcherFile(), `${JSON.stringify(wanted, null, 2)}\n`);
    return true;
  } finally {
    await release();
  }
}

// a .cmdless file's launch, read and checked now - nothing reads the file
// after this
export const readLaunch = (file: string) => parseLaunch(fs.readFileSync(file, 'utf8'));

// a line in the launcher's log - what open says, since nothing it's run
// from shows its output
export function logLaunch(message: string) {
  try {
    fs.mkdirSync(launchRoot(), { recursive: true });
    fs.appendFileSync(path.join(launchRoot(), 'launch.log'), `${new Date().toISOString()} ${message}\n`);
  } catch {
    // nowhere left to say it
  }
}
