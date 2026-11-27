#!/usr/bin/env node

// launch-tray [add <file> | open <file>]
//
// The tray .cmdless files open through (ui-runtime's launcher passes them
// here). The first run is the tray; any run after it hands its file to that
// one and exits. add keeps a file among the launches, once it's been
// trusted; open runs a kept one at once, and asks to keep one from anywhere
// else first.

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { compareVersions } from '@cmdless/core/node';
import { UIHost } from '@cmdless/ui-sdk/node';
import type { RemoteTray, TrayMenuItem } from '@cmdless/ui-sdk/node';
import { describeLaunch, isKept, keptFileName, keptLaunches, launchesFolder, readLaunch } from './launches.js';
import type { KeptLaunch, Launch } from './launches.js';
import { logFileFor, runLaunch } from './run.js';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { name: string; version: string };
const TITLE = 'cmdless launch';

type Request = { type: 'add' | 'open'; file: string };

const isRequest = (value: unknown): value is Request =>
  !!value && typeof value === 'object'
  && ((value as Request).type === 'add' || (value as Request).type === 'open')
  && typeof (value as Request).file === 'string';

// what this run was asked: add or open a file, or nothing (just the tray)
function parse(args: string[]): Request | undefined {
  const [type, file, extra] = args;
  if (type === undefined) return undefined;
  if ((type !== 'add' && type !== 'open') || file === undefined || extra !== undefined) {
    console.error('usage: launch-tray [add <file> | open <file>]');
    process.exit(2);
  }
  return { type, file: path.resolve(file) };
}

const request = parse(process.argv.slice(2));

let userData = '';
let tray: RemoteTray | undefined;
let kept: KeptLaunch[] = [];
let update: string | undefined;

// what the tray did - it has no terminal to say it in
function log(message: string) {
  fs.appendFileSync(path.join(userData, 'launch-tray.log'), `${new Date().toISOString()} ${message}\n`);
}

const host = await UIHost.create({
  app: pkg.name,
  // the tray, and hearing other runs, before any other run can reach this one
  initialize: async host => {
    if (!host.params.hasSingleInstanceLock) return;
    userData = host.params.userData;
    host.onMessage(({ message }) => {
      if (isRequest(message)) void handle(message);
    });
    fs.mkdirSync(launchesFolder(userData), { recursive: true });
    kept = readKept(userData);
    tray = await host.createTray({ icon: '', tooltip: TITLE, menu: menu() });
  },
});

// another run is the tray: it gets this one's file, and this one's done
if (!host.params.hasSingleInstanceLock) {
  if (request) await host.send(request);
  host.dispose();
  process.exit(0);
}

function readKept(folder: string) {
  return keptLaunches(folder, (file, error) => log(`skipped ${file}: ${error.message}`));
}

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
  kept = readKept(userData);
  void tray?.update({ menu: menu() }).catch(() => { });
}

// the folder changing - added to here, or by hand - changes the menu
let refreshing: NodeJS.Timeout | undefined;
fs.watch(launchesFolder(userData), () => {
  clearTimeout(refreshing);
  refreshing = setTimeout(refreshMenu, 100);
});

tray!.onEvent(event => {
  if (event.event !== 'menu-item') return;
  if (event.item === 'quit') {
    host.dispose();
    process.exit(0);
  }
  const index = /^launch:(\d+)$/.exec(event.item)?.[1];
  const launch = index === undefined ? undefined : kept[Number(index)];
  if (launch) void run(launch);
});

async function notify(title: string, body?: string) {
  await host.showNotification({ title, body }).catch(() => { });
}

// a file from anywhere, kept once it's been trusted: what it runs is shown,
// and only Add keeps it. Hands back the kept copy, or nothing.
async function add(file: string): Promise<KeptLaunch | undefined> {
  let text: string;
  let launch: Launch;
  try {
    text = fs.readFileSync(file, 'utf8');
    launch = readLaunch(file);
  } catch (error) {
    log(`couldn't read ${file}: ${(error as Error).message}`);
    await notify(`Couldn't open ${path.basename(file)}`, (error as Error).message);
    return undefined;
  }
  if (isKept(userData, file)) return { ...launch, file };

  const target = path.join(launchesFolder(userData), keptFileName(launch.name));
  const replacing = fs.existsSync(target);
  const dialog = await host.openDialog({
    type: 'question',
    message: replacing ? `Replace “${launch.name}” in ${TITLE}?` : `Add “${launch.name}” to ${TITLE}?`,
    detail: `From ${file}\n\nIt runs:\n${describeLaunch(launch)}`,
    buttons: [replacing ? 'Replace' : 'Add', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
  });
  const { response } = await dialog.closed;
  if (response !== 0) {
    log(`didn't add ${file}`);
    return undefined;
  }
  fs.writeFileSync(target, text);
  log(`added ${launch.name} from ${file}`);
  refreshMenu();
  return { ...launch, file: target };
}

// a kept launch, run - saying so only if it fails
async function run(launch: KeptLaunch) {
  log(`launching ${launch.name}`);
  const failed = await runLaunch(launch, logFileFor(userData, launch.file));
  if (failed) {
    log(`${launch.name} failed: ${failed}`);
    await notify(`${launch.name} didn't launch`, failed);
  }
}

async function handle({ type, file }: Request) {
  try {
    const launch = await add(file);
    if (launch && type === 'open') await run(launch);
  } catch (error) {
    log(`${type} ${file} failed: ${(error as Error).message}`);
  }
}

// whether there's a newer version - shown, never installed
void promisify(execFile)('npm', ['view', pkg.name, 'version'], { shell: process.platform === 'win32' })
  .then(({ stdout }) => {
    const latest = stdout.trim();
    if (latest && compareVersions(latest, pkg.version) > 0) {
      update = latest;
      void tray?.update({ menu: menu() }).catch(() => { });
    }
  }, () => { });

log(`started ${pkg.version}`);
if (request) await handle(request);
