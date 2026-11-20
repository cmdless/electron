import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { app } from 'electron';
import { electronApp, optimizer } from '@electron-toolkit/utils';
import {
  isEphemeralCmdlessApp, listenOnce, rejectService, resolveCmdlessApp, resolveService, sendTo,
} from '@cmdless/ui-sdk/node';
import type { HostService } from '@cmdless/ui-sdk/node';
import { DialogHandle, Host } from './hosting.js';
import { exeName, writeDesktopFile } from './platform.js';

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

// how long the owner gets to connect once it's been told where to
const OWNER_TIMEOUT_MS = 10_000;

// quits - once any app-modal message box is answered: macOS won't let an
// app quit while one is up, and one asked for meanwhile is lost
function quit() {
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
    // named app's own name (see platform.ts)
    electronApp.setAppUserModelId(ephemeral ? 'dev.cmdless.ui' : exeName(appName));
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
  // connected
  app.on('second-instance', async (_, __, ___, data: unknown) => {
    try {
      await host.owned;
      await sendTo((data as Forwarded).reply, { type: 'resolve', value: host.service });
    } catch (error) {
      console.error('ui-runtime: answering a second instance failed:', error);
    }
  });

  await ready;
  // the owner is told where to connect - and if it never does, nothing
  // would ever end this process, so it ends itself
  await resolveService(host.service);
  const ownerTimeout = setTimeout(quit, OWNER_TIMEOUT_MS);
  void host.owned.then(() => clearTimeout(ownerTimeout));
}

void main().catch(async error => {
  console.error(error);
  await rejectService(error).catch(() => { });
  app.exit(1);
});
