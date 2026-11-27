#!/usr/bin/env node

// The launch tray: one per user, serving launchProtocol on its socket -
// LaunchHost (in @cmdless/ui-sdk) connects to it, starting it if it isn't
// up. It keeps launches, and runs them: a launch with named commands asks
// which, unless it's told, and one using a source that isn't trusted yet
// asks to trust it - once, for every launch after.

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { compareVersions, isPendingService, listenExclusive, rejectService, resolveService } from '@cmdless/core/node';
import type { DaemonService } from '@cmdless/core/node';
import { createSocketServer } from '@cmdless/rpc-sdk/node';
import { commandNames, commandsFor, describeSource, launchProtocol, sameLaunch, sourceKey, validLaunch } from '@cmdless/ui-sdk';
import type { AddResult, Launch, LaunchSource, OpenOptions, OpenResult } from '@cmdless/ui-sdk';
import { getLaunchSocketPath, UIHost } from '@cmdless/ui-sdk/node';
import type { RemoteTray, TrayMenuItem } from '@cmdless/ui-sdk/node';
import { keep, keptFile, keptLaunches, launchesFolder } from './launches.js';
import type { KeptLaunch } from './launches.js';
import { logFileFor, runLaunch } from './run.js';
import { commandLine, trustStore } from './sources.js';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { name: string; version: string };
const TITLE = 'cmdless launch';
// past this many named commands, the choice is a list rather than buttons
const MOST_BUTTONS = 4;

let host: UIHost;
let tray: RemoteTray;
let kept: KeptLaunch[] = [];
let update: string | undefined;
let trusted: ReturnType<typeof trustStore>;

// what the tray did - it has no terminal to say it in
function log(message: string) {
  fs.appendFileSync(path.join(host.params.userData, 'launch-tray.log'), `${new Date().toISOString()} ${message}\n`);
}

const readKept = () => keptLaunches(host.params.userData, (file, error) => log(`skipped ${file}: ${error.message}`));

// the launches - one with named commands as a submenu of them - then the
// trusted sources, an update if there is one, and Quit. A launch's id is its
// place in the list as the menu was built.
function menu(): TrayMenuItem[] {
  const sources = Object.entries(trusted.all());
  return [
    {
      type: 'submenu', label: 'Launch', submenu: kept.length
        ? kept.map((launch, i): TrayMenuItem => {
          const names = commandNames(launch);
          return names
            ? { type: 'submenu', label: launch.name, submenu: names.map(name => ({ id: `launch:${i}:${name}`, label: name })) }
            : { id: `launch:${i}`, label: launch.name };
        })
        : [{ id: 'none', label: 'Nothing added yet', enabled: false }],
    },
    {
      type: 'submenu', label: 'Trusted Sources', submenu: sources.length
        ? sources.map(([key, description]) => ({
          type: 'submenu', label: description, submenu: [{ id: `untrust:${key}`, label: 'Stop Trusting' }],
        }))
        : [{ id: 'none', label: 'None yet', enabled: false }],
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

// which of a launch's named commands to run - nothing, if none is chosen
async function chooseCommand(launch: Launch, names: string[]): Promise<string | undefined> {
  if (names.length <= MOST_BUTTONS) {
    const dialog = await host.openDialog({
      type: 'question',
      message: `Which ${launch.name}?`,
      buttons: [...names, 'Cancel'],
      cancelId: names.length,
    });
    return names[(await dialog.closed).response];
  }
  const form = await host.openForm<{ command?: string }>({
    schema: { type: 'object', required: ['command'], properties: { command: { type: 'string', title: launch.name, enum: names } } },
    uiSchema: { command: { 'ui:autofocus': true } },
    submitText: 'Run',
    window: { title: `${TITLE}: ${launch.name}` },
  });
  return (await form.closed)?.command;
}

// Every source the commands use, trusted - asking about any that aren't,
// all at once. False if they're not.
async function trustSources(launch: Launch, sources: LaunchSource[]) {
  const untrusted = [...new Map(sources.filter(source => !trusted.has(source)).map(source => [sourceKey(source), source])).values()];
  if (!untrusted.length) return true;
  const dialog = await host.openDialog({
    type: 'question',
    message: untrusted.length === 1 ? `Trust ${describeSource(untrusted[0])}?` : `Trust these ${untrusted.length} sources?`,
    detail: [
      `${launch.name} runs ${untrusted.length === 1 ? 'it' : 'them'}:`,
      ...untrusted.map(source => `  ${describeSource(source)}`),
      '',
      `Any launch can then run ${untrusted.length === 1 ? 'its commands' : 'their commands'} with any arguments, without asking.`,
    ].join('\n'),
    buttons: ['Trust and Run', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
  });
  if ((await dialog.closed).response !== 0) return false;
  trusted.trust(untrusted);
  log(`trusted ${untrusted.map(sourceKey).join(', ')}`);
  refreshMenu();
  return true;
}

async function add(launch: Launch): Promise<AddResult> {
  const file = keptFile(host.params.userData, launch.name);
  const replacing = fs.existsSync(file);
  if (replacing && kept.some(each => each.file === file && sameLaunch({ name: each.name, sources: each.sources, commands: each.commands }, launch))) return 'unchanged';
  keep(host.params.userData, launch);
  log(`${replacing ? 'replaced' : 'added'} ${launch.name}`);
  refreshMenu();
  return replacing ? 'replaced' : 'added';
}

// Runs a launch: its commands - asking which, if it has several and isn't
// told - once their sources are trusted; kept too, with keep. Running
// carries on after this settles, saying so only if it fails.
async function open(launch: Launch, { command, keep: keeping }: OpenOptions = {}): Promise<OpenResult> {
  const names = commandNames(launch);
  const chosen = names && command === undefined ? await chooseCommand(launch, names) : command;
  if (names && chosen === undefined) return 'cancelled';
  const commands = commandsFor(launch, chosen);
  if (!await trustSources(launch, commands.map(each => launch.sources[each.source]))) return 'cancelled';
  if (keeping) await add(launch);

  const lines = commands.map(each => commandLine(launch.sources[each.source], each));
  const label = chosen ? `${launch.name} (${chosen})` : launch.name;
  void (async () => {
    log(`launching ${label}`);
    const failed = await runLaunch(label, lines, logFileFor(host.params.userData, keptFile(host.params.userData, launch.name)));
    if (failed) {
      log(`${label} failed: ${failed}`);
      await notify(`${label} didn't launch`, failed);
    }
  })();
  return 'opened';
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
    server.onRequest.open(async ({ launch, command, keep }) => {
      await ready;
      return open(validLaunch(launch), { command, keep });
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
  trusted = trustStore(host.params.userData);
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
    if (event.item.startsWith('untrust:')) {
      trusted.forget(event.item.slice('untrust:'.length));
      log(`stopped trusting ${event.item.slice('untrust:'.length)}`);
      return refreshMenu();
    }
    const [, index, command] = /^launch:(\d+)(?::(.+))?$/.exec(event.item) ?? [];
    const launch = index === undefined ? undefined : kept[Number(index)];
    if (launch) void open(launch, { command }).catch(error => log(`${launch.name} failed: ${(error as Error).message}`));
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
