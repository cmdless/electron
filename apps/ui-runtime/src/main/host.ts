import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { app, Menu, powerMonitor, shell } from 'electron';
import { electronApp, optimizer } from '@electron-toolkit/utils';
import {
  isEphemeralCmdlessApp, listenOnce, rejectService, resolveCmdlessApp, resolveService, sendTo,
} from '@cmdless/ui-sdk/node';
import type { HostService } from '@cmdless/ui-sdk/node';
import { DialogHandle, Host } from './hosting.js';
import { appMenu } from './menu.js';
import { appId, startMenuShortcut, writeDesktopFile } from './platform.js';

// what a process that lost the lock hands the lock holder: where to send
// this host's address, once its owner has connected
type Forwarded = { reply: string };

const cleanupEntry = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cleanup.js');

// kept for as long as this process lives: its end of the cleaner's stdin is
// what tells the cleaner this process is gone
let cleaner: ChildProcess | undefined;

// a throwaway host's userData can't be removed from here - Chromium is still
// using it until this process is gone - so a process that outlives this one
// removes it, however this one ends
function cleanUpWhenGone(userData: string) {
  cleaner = spawn(process.execPath, [cleanupEntry, userData], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['pipe', 'ignore', 'ignore'],
    detached: true,
  });
  cleaner.stdin?.on('error', () => { });
  cleaner.unref();
}

// Windows: the Start Menu shortcut that names a named app's notifications -
// kept pointing at whichever copy of Electron it last ran from
function writeShortcut(appName: string) {
  const file = startMenuShortcut(appName);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const options = { target: process.execPath, appUserModelId: appId(appName), description: appName };
    if (!shell.writeShortcutLink(file, fs.existsSync(file) ? 'replace' : 'create', options)) throw new Error('not written');
  } catch (error) {
    console.error(`ui-runtime: couldn't write ${file}:`, (error as Error).message);
  }
}

// how long the owner gets to connect once it's been told where to
const OWNER_TIMEOUT_MS = 10_000;

// whether this process is quitting because it decided to (quit, below), or
// because the system is logging out, restarting or shutting down - any
// other quit is someone asking it to (the Dock's Quit, say)
let quitting = false;
let poweringOff = false;

// quits - once any app-modal message box is answered: macOS won't let an
// app quit while one is up, and one asked for meanwhile is lost
function quit() {
  quitting = true;
  void DialogHandle.whenNoneModal().then(() => app.quit());
}

async function main() {
  // without this, Ctrl+C leaves Electron's own default (uncontrolled)
  // teardown to tear down windows
  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);

  // no Dock icon until a window or dialog is showing
  app.dock?.hide();

  // the app name is the single-instance lock, and names userData - a
  // throwaway (ephemeral) one under temp, which its owner cleans up
  const appName = resolveCmdlessApp();
  const ephemeral = isEphemeralCmdlessApp(appName);
  const userData = path.join(app.getPath(ephemeral ? 'temp' : 'appData'), appName);
  app.setName(appName);
  app.setPath('userData', userData);
  if (ephemeral) cleanUpWhenGone(userData);
  // Linux names a named app's windows from its .desktop file
  if (process.platform === 'linux' && !ephemeral) app.setDesktopName(writeDesktopFile(appName, process.execPath));

  // losing the lock: the lock holder sends its address here once its own
  // owner has connected, and this process passes it on to its creator
  const reply = await listenOnce<HostService>();
  if (!app.requestSingleInstanceLock({ reply: reply.socketPath } satisfies Forwarded)) {
    try {
      await resolveService(await reply.message);
    } catch (error) {
      await rejectService(error).catch(() => { });
    }
    return app.quit();
  }
  reply.close();

  // everything that has to be set up before a host is answered
  const ready = (async () => {
    await app.whenReady();
    // what the taskbar groups windows by, and names notifications for - a
    // named app's own (see platform.ts)
    electronApp.setAppUserModelId(ephemeral ? 'dev.cmdless.ui' : appId(appName));
    if (process.platform === 'win32' && !ephemeral) writeShortcut(appName);
    // Default open or close DevTools by F12 in development
    // and ignore CommandOrControl + R in production.
    // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
    app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window));
    // the owner's connection decides when this ends, not its windows
    app.on('window-all-closed', () => { });
  })();

  const host = await Host.start({ appName, userData, ephemeral }, ready);
  // the host lives as long as its owner's connection
  void host.ownerClosed.then(quit);
  // a Dock icon only while a window or dialog is open - changed only when
  // that flips, since show() settles later and a stray one would undo a hide
  let docked = false;
  host.onHandlesChanged(count => {
    if (count > 0 === docked) return;
    docked = count > 0;
    if (docked) void app.dock?.show();
    else app.dock?.hide();
  });

  // a process that lost the lock gets the address only once the owner has
  // connected and set itself up - so nothing it sends the owner arrives
  // before the owner is listening
  app.on('second-instance', async (_, __, ___, data: unknown) => {
    try {
      await host.owned;
      await sendTo((data as Forwarded).reply, { type: 'resolve', value: host.service });
    } catch (error) {
      console.error('ui-runtime: answering a second instance failed:', error);
    }
  });

  await ready;
  // Quit - the menu's, or the Dock's - closes every window and dialog, and
  // quits as it always would unless a tray is up: the app goes on for that,
  // as it does with no windows open. A logout, restart or shutdown is
  // announced before it asks the app to quit, and that quits outright, so
  // it's never held up.
  const quitAsked = () => host.hasTray ? host.closeShown() : quit();
  Menu.setApplicationMenu(appMenu(quitAsked));
  powerMonitor.on('shutdown', () => { poweringOff = true; });
  app.on('before-quit', event => {
    if (quitting || poweringOff) return;
    event.preventDefault();
    quitAsked();
  });
  // the owner is told where to connect - and if it never does, nothing
  // would ever end this process, so it ends itself
  await resolveService(host.service);
  const ownerTimeout = setTimeout(quit, OWNER_TIMEOUT_MS);
  // connecting is what it has to do in time - setting itself up after can take
  // as long as it takes
  void host.connected.then(() => clearTimeout(ownerTimeout));
}

void main().catch(async error => {
  console.error(error);
  await rejectService(error).catch(() => { });
  app.exit(1);
});
