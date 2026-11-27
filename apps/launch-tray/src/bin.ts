#!/usr/bin/env node

// The launch tray: one per user, serving launchProtocol on its socket -
// LaunchHost (in @cmdless/ui-sdk) connects to it, starting it if it isn't
// up. It keeps the launches that have been trusted and runs them: one asked
// to be added or opened is shown, with what it runs, unless the same launch
// is kept already.

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { compareVersions, isPendingService, listenExclusive, rejectService, resolveService } from '@cmdless/core/node';
import type { DaemonService } from '@cmdless/core/node';
import { createSocketServer } from '@cmdless/rpc-sdk/node';
import { describeLaunch, launchProtocol, sameLaunch, validLaunch } from '@cmdless/ui-sdk';
import type { AddResult, Launch, OpenResult } from '@cmdless/ui-sdk';
import { getLaunchSocketPath, UIHost } from '@cmdless/ui-sdk/node';
import type { RemoteTray, TrayMenuItem } from '@cmdless/ui-sdk/node';
import { keep, keptFile, keptLaunches, launchesFolder } from './launches.js';
import type { KeptLaunch } from './launches.js';
import { logFileFor, runLaunch } from './run.js';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { name: string; version: string };
const TITLE = 'cmdless launch';

let host: UIHost;
let tray: RemoteTray;
let kept: KeptLaunch[] = [];
let update: string | undefined;

// what the tray did - it has no terminal to say it in
function log(message: string) {
  fs.appendFileSync(path.join(host.params.userData, 'launch-tray.log'), `${new Date().toISOString()} ${message}\n`);
}

const readKept = () => keptLaunches(host.params.userData, (file, error) => log(`skipped ${file}: ${error.message}`));

// the launches, then an update if there is one, then Quit - a launch's id is
// its place in the list as the menu was built
function menu(): TrayMenuItem[] {
  return [
    {
      type: 'submenu', label: 'Launch', submenu: kept.length
        ? kept.map((launch, i) => ({ id: `launch:${i}`, label: launch.name }))
        : [{ id: 'none', label: 'Nothing added yet', enabled: false }],
    },
    { type: 'separator' },
    ...update ? [{ id: 'update', label: `Update available (${update})`, enabled: false }] : [],
    { id: 'quit', label: 'Quit' },
  ];
}

function refreshMenu() {
  kept = readKept();
  void tray.update({ menu: menu() }).catch(() => { });
}

async function notify(title: string, body?: string) {
  await host.showNotification({ title, body }).catch(() => { });
}

// Shown before a launch is kept, with exactly what it runs: whether to go
// ahead. Escape, or closing it, is Cancel.
async function approve(launch: Launch, action: 'add' | 'open') {
  const replacing = fs.existsSync(keptFile(host.params.userData, launch.name));
  const verb = action === 'open' ? 'Open' : replacing ? 'Replace' : 'Add';
  const dialog = await host.openDialog({
    type: 'question',
    message: action === 'open' ? `Open “${launch.name}”?` : `${verb} “${launch.name}” in ${TITLE}?`,
    detail: [
      `It runs:\n${describeLaunch(launch)}`,
      action === 'open' ? `\nIt'll be kept in ${TITLE}${replacing ? ', in place of the one with its name,' : ''} and run without asking next time.` : '',
    ].join('\n'),
    buttons: [verb, 'Cancel'],
    defaultId: 1,
    cancelId: 1,
  });
  return { approved: (await dialog.closed).response === 0, replacing };
}

// the kept launch that's just so, if there is one
const keptAs = (launch: Launch) => kept.find(each => sameLaunch(each, launch));

async function add(launch: Launch): Promise<AddResult> {
  if (keptAs(launch)) return 'unchanged';
  const { approved, replacing } = await approve(launch, 'add');
  if (!approved) return 'cancelled';
  keep(host.params.userData, launch);
  log(`${replacing ? 'replaced' : 'added'} ${launch.name}`);
  refreshMenu();
  return replacing ? 'replaced' : 'added';
}

async function open(launch: Launch): Promise<OpenResult> {
  let found = keptAs(launch);
  if (!found) {
    const { approved, replacing } = await approve(launch, 'open');
    if (!approved) return 'cancelled';
    found = keep(host.params.userData, launch);
    log(`${replacing ? 'replaced' : 'added'} ${launch.name}, to open`);
    refreshMenu();
  }
  void run(found);
  return 'opened';
}

// a kept launch, run - saying so only if it fails
async function run(launch: KeptLaunch) {
  log(`launching ${launch.name}`);
  const failed = await runLaunch(launch, logFileFor(host.params.userData, launch.file));
  if (failed) {
    log(`${launch.name} failed: ${failed}`);
    await notify(`${launch.name} didn't launch`, failed);
  }
}

async function main() {
  // the socket first: it's the lock, and where LaunchHost connects. Requests
  // wait for the tray, so a client connects at once, however long the
  // tray's host takes to start.
  let started!: () => void;
  const ready = new Promise<void>(resolve => started = resolve);
  const lock = createSocketServer(launchProtocol.accept(server => {
    server.onRequest.add(async ({ launch }) => {
      await ready;
      return add(validLaunch(launch));
    });
    server.onRequest.open(async ({ launch }) => {
      await ready;
      return open(validLaunch(launch));
    });
  }));
  const service: DaemonService = { address: getLaunchSocketPath() };
  if (!await listenExclusive(lock, service.address)) {
    if (isPendingService()) await resolveService(service);
    return;
  }
  if (isPendingService()) await resolveService(service);

  host = await UIHost.create({
    app: pkg.name,
    initialize: async host => {
      fs.mkdirSync(launchesFolder(host.params.userData), { recursive: true });
      tray = await host.createTray({ icon: '', tooltip: TITLE, menu: [] });
    },
  });
  kept = readKept();
  await tray.update({ menu: menu() });
  log(`started ${pkg.version}`);

  const quit = () => {
    lock.close();
    host.dispose();
    process.exit(0);
  };
  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);
  host.onClose(quit);

  tray.onEvent(event => {
    if (event.event !== 'menu-item') return;
    if (event.item === 'quit') return quit();
    const index = /^launch:(\d+)$/.exec(event.item)?.[1];
    const launch = index === undefined ? undefined : kept[Number(index)];
    if (launch) void run(launch);
  });

  // the folder changing - added to here, or by hand - changes the menu
  let refreshing: NodeJS.Timeout | undefined;
  fs.watch(launchesFolder(host.params.userData), () => {
    clearTimeout(refreshing);
    refreshing = setTimeout(refreshMenu, 100);
  });

  // whether there's a newer version - shown, never installed
  void promisify(execFile)('npm', ['view', pkg.name, 'version'], { shell: process.platform === 'win32' })
    .then(({ stdout }) => {
      const latest = stdout.trim();
      if (latest && compareVersions(latest, pkg.version) > 0) {
        update = latest;
        void tray.update({ menu: menu() }).catch(() => { });
      }
    }, () => { });

  started();
}

main().catch(async error => {
  console.error(error);
  if (isPendingService()) await rejectService(error).catch(() => { });
  process.exit(1);
});
