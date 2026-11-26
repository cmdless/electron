#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { UIHost } from '@cmdless/ui-sdk/node';
import type { RemoteWindow, TrayMenuItem, TrayParams } from '@cmdless/ui-sdk/node';
import { ghInstalled, startLogin, tokenFor } from './accounts.js';
import { approveDeployment, approvePullRequest } from './approvals.js';
import { byUrl } from '../shared/items.js';
import type { Item, Items } from '../shared/items.js';
import { GitHub } from './github.js';
import type { RateLimit } from './github.js';
import { DEFAULT_POLL_SECONDS, Inbox } from './inbox.js';
import { connect, serve, trayProtocol, userOf } from './peers.js';
import type { SentItem, Tray, TrayInfo } from './peers.js';
import { memory, pointer, prefixOps } from '@cmdless/rpc-sdk';
import type { Operation } from '@cmdless/rpc-sdk';
import { accountOf, createRtcHost, parseProvider, providerLabel, providerName, providerUsage, signalingFor } from '@cmdless/rtc-sdk/node';
import type { ProviderSettings, RtcHost } from '@cmdless/rtc-sdk/node';
import { ensureAuth, providerKey } from '@cmdless/auth-sdk/node';
import type { ProviderStatus } from '@cmdless/auth-sdk/node';
import { createLog, logFile } from './log.js';
import { coalesce, firstLine, writeAtomic } from './util.js';
import { logViewer } from './logViewer.js';
import { approvalsWindow } from './approvalsWindow.js';
import { approvalsProtocol } from '../shared/protocols.js';
import type { Devices } from '../shared/protocols.js';

const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { name: string };
const asset = (name: string) => fileURLToPath(new URL(`../../assets/${name}`, import.meta.url));
const icons = { clear: asset('checkTemplate.png'), waiting: asset('alertTemplate.png'), syncing: asset('syncTemplate.png') };

// the name it goes by, without the package's scope
const appName = pkg.name.replace(/^@[^/]+\//, '');

// where to send someone who doesn't have gh yet
const GH_DOWNLOAD = 'https://cli.github.com/';

// the account's inbox, and its notification settings - which go by email,
// and which to the inbox - for whoever's signed in to the browser
const NOTIFICATIONS = 'https://github.com/notifications';
const NOTIFICATION_SETTINGS = 'https://github.com/settings/notifications';

// how much of a title a menu shows
const TITLE_LENGTH = 60;

// --user <login>: the GitHub account this runs for
// --org <owner>: only what's in this owner's repositories (repeatable)
// set provider ...: what the trays find each other through, kept in
//   config.json for every run after - set provider none, and it's on its own
const USAGE = `usage: ${appName} --user <github login> [--org <owner>]...
       ${appName} set provider none
${providerUsage(`${appName} set`, '       ')}`;
const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: { user: { type: 'string' }, org: { type: 'string', multiple: true } },
});
// the provider set provider gives - null for none
let setProvider: ProviderSettings | null | undefined;
try {
  if (positionals.length) {
    const [command, setting, ...rest] = positionals;
    if (command !== 'set' || setting !== 'provider') throw new Error(`no command ${positionals.join(' ')}`);
    setProvider = rest[0] === 'none' && rest.length === 1 ? null : parseProvider(rest, to => path.resolve(to));
  } else if (!args.user) throw new Error('--user is needed');
} catch (error) {
  console.error(`${firstLine(error)}\n\n${USAGE}`);
  process.exit(2);
}
const user = args.user ?? '';
const orgs = (args.org ?? []).map(org => org.toLowerCase());

// the app's own host, named after the package - running this again joins the
// one that's already up rather than starting another
const host = await UIHost.create({ app: pkg.name });

// it's already running, tray and all, so there's nothing more to do here -
// and a setting would be written over by it, so it isn't changed
if (!host.params.hasSingleInstanceLock) {
  host.dispose();
  if (setProvider !== undefined) {
    console.error(`${appName} is running - quit it first to change its provider`);
    process.exit(1);
  }
  process.exit(0);
}

// a log in the app's own userData
const log = createLog(host.params.userData);

// GitHub, asked conditionally - what it last answered is kept in userData,
// this machine's own business
const github = new GitHub(path.join(host.params.userData, 'github-cache.json'), appName);
await github.load();
const inbox = new Inbox(github, user, orgs);

// this machine's own settings, in userData - and, beside them, what the last
// refresh cost and where GitHub's rate limit stood after it
type Config = {
  // this machine, as the other trays know it
  deviceId: string;
  // what the trays find each other through - none, and it's on its own
  provider?: ProviderSettings;
  autoMarkDone: boolean;
  lastRefresh?: { at: string; requests: number; quotaCosting: number };
  rateLimit?: RateLimit;
};
const configFile = path.join(host.params.userData, 'config.json');
const config: Config = {
  deviceId: crypto.randomUUID(),
  autoMarkDone: false,
  ...JSON.parse(await fs.promises.readFile(configFile, 'utf8').catch(() => '{}')) as Partial<Config>,
};
const saveConfig = () => writeAtomic(configFile, `${JSON.stringify(config, null, 2)}\n`);
// a share from before providers is a folder provider
const { share } = config as { share?: { path: string } };
if (share) {
  config.provider ??= { kind: 'folder', path: share.path };
  delete (config as { share?: unknown }).share;
}
if (setProvider !== undefined) {
  config.provider = setProvider ?? undefined;
  await saveConfig();
  console.log(config.provider ? `sharing through ${providerLabel(config.provider)}` : 'not sharing');
  host.dispose();
  process.exit(0);
}
await saveConfig();
log(config.provider ? `started, sharing through ${providerLabel(config.provider)}` : 'started, not sharing');

// this user's items, served to the other trays - what was there last time
// until the first scan
const itemsFile = path.join(host.params.userData, 'items.json');
const store = await trayProtocol.createStore({
  items: memory(JSON.parse(await fs.promises.readFile(itemsFile, 'utf8').catch(() => '{}')) as Items),
});
const mine = () => Object.values(store.state.items);

// every tray's items by device - this one's and every one it's connected to,
// each passed on as it changes - for the approvals window, and the menu
const devices = await approvalsProtocol.createStore({
  devices: memory<Devices>({ [config.deviceId]: { user, items: store.state.items } }),
  status: memory({ deviceId: config.deviceId, online: false }),
});
const changeDevices = (ops: Operation[]) => void devices.patch('devices', ops).catch(() => { });
store.watch('items', ({ ops }) => changeDevices(prefixOps(ops, pointer(config.deviceId, 'items'))));

// every other running tray, by device: connected to once a run of it, and not
// tried again until it runs again. Listed only while it's connected and its
// items have come.
type Link = { user: string; session: string; tray?: Tray; close?: () => void };
const links = new Map<string, Link>();
const connected = () => [...links].filter(([deviceId, link]) => link.tray && devices.state.devices[deviceId])
  .map(([deviceId, link]) => ({ ...link, tray: link.tray!, items: devices.state.devices[deviceId].items }));
// gone from the window too
const forget = (deviceId: string) => {
  if (devices.state.devices[deviceId]) changeDevices([{ op: 'remove', path: pointer(deviceId) }]);
};
// everyone listed, each with what all their trays have, once over
const users = () => {
  const byUser = new Map<string, Items>();
  for (const link of connected()) byUser.set(link.user, { ...byUser.get(link.user), ...link.items });
  return [...byUser].map(([name, items]) => ({ user: name, items: Object.values(items) }))
    .sort((a, b) => a.user.localeCompare(b.user));
};
// a user's connected trays - the first is the one asked to do anything only
// one should
const traysOf = (name: string) => connected().filter(link => link.user === name).map(link => link.tray);
const itemOf = (name: string, url: string) => connected().find(link => link.user === name && link.items[url])?.items[url];

// while something asked for from the menu is being done, the menu is off but
// for Quit; refreshes on their own don't turn it off
let busy = false;
// without gh there's nothing to check with: the menu offers to look again,
// or to get it, and the rest stays off
let ghMissing = false;
// whether gh is signed in to this user - unknown until the first check
let signedIn: boolean | undefined;
// a sign-in is going on, in the browser
let signingIn = false;

// the next poll: after as long as GitHub asks, or sooner if a refresh is
// asked for first
let nextPoll: NodeJS.Timeout | undefined;
let pollSeconds = DEFAULT_POLL_SECONDS;

// what a menu item does when it's clicked, as its id - `to` is the other
// user whose tray does it
type Action =
  | { do: 'view'; url: string }
  | { do: 'approve'; url: string; environment?: number }
  | { do: 'ask-approval'; to: string; url: string }
  | { do: 'approve-as'; to: string; url: string; environment?: number }
  | { do: 'ask-refresh'; to: string };
const actionId = (action: Action) => JSON.stringify(action);

const titled = (title: string) => title.length > TITLE_LENGTH ? `${title.slice(0, TITLE_LENGTH - 1)}…` : title;

// the tray as a device on the provider - only while gh is signed in as this
// user, which is when the tray takes part at all, and while the provider's
// account (if it has one) is signed in
let rtc: RtcHost<TrayInfo> | undefined;
const session = crypto.randomUUID();
const provider = config.provider;
// the provider's account, signed in to through the auth broker - which
// keeps the sign-in for every run after, and for anything else using it
const account = provider && accountOf(provider);
const auth = account && await ensureAuth(fileURLToPath(import.meta.resolve('@cmdless/auth/daemon')));
// the broker's sign-in to it, as last heard
let accountStatus: ProviderStatus['status'] = 'signed-out';
const signaling = provider && signalingFor(provider, async () => {
  if (!auth || !account) throw new Error('not signed in');
  return (await auth.request.getToken({ provider: account, interactive: false })).accessToken;
});

// Check Now, with GitHub's rate limit beside it: what's left this hour of
// how much, and what the last refresh cost of how many requests it made
function checkNowLabel() {
  const { lastRefresh, rateLimit } = config;
  const parts = [
    ...rateLimit ? [`${rateLimit.remaining.toLocaleString()} / ${rateLimit.limit.toLocaleString()}`] : [],
    ...lastRefresh ? [`last ${lastRefresh.quotaCosting} (${lastRefresh.requests})`] : [],
  ];
  return parts.length ? `Check Now (${parts.join(', ')})` : 'Check Now';
}

function menu(): TrayMenuItem[] {
  const usable = !busy && !ghMissing;
  // nothing of anyone's shows until gh is signed in as this user
  const online = rtc !== undefined;
  const peers = users();

  // approving it - a deployment one environment at a time: this user's with
  // their own account, someone else's by having their tray do it with theirs
  const approveItem = (owner: string, item: Item, enabled: boolean): TrayMenuItem => {
    const action = (environment?: number): Action => owner === user
      ? { do: 'approve', url: item.url, environment }
      : { do: 'approve-as', to: owner, url: item.url, environment };
    return item.kind === 'deployment'
      ? {
        type: 'submenu', label: 'Auto Approve', enabled, submenu: item.environments.map(environment => ({
          id: actionId(action(environment.id)), label: environment.name,
        })),
      }
      : { id: actionId(action()), label: 'Auto Approve', enabled };
  };

  // grouped by repository; each one opens on GitHub, and is approved - or,
  // for someone else's, they're asked to approve it. A pull request marked *
  // was pushed to last by whoever it's waiting on, so only someone else can.
  const grouped = (owner: string, items: Item[]): TrayMenuItem[] => {
    const byRepo = new Map<string, Item[]>();
    for (const item of items) byRepo.set(item.repo, [...byRepo.get(item.repo) ?? [], item]);
    return [...byRepo].sort(([a], [b]) => a.localeCompare(b)).map(([repo, inRepo]) => ({
      type: 'submenu', label: repo, enabled: usable,
      submenu: inRepo.sort((a, b) => a.number - b.number).map(item => {
        const othersOnly = item.kind === 'pull-request' && item.othersOnly;
        return {
          type: 'submenu', label: titled(`${othersOnly ? '*' : ''}#${item.number} ${item.title}`), enabled: usable,
          submenu: [
            { id: actionId({ do: 'view', url: item.url }), label: 'View in Browser...' },
            { type: 'separator' },
            ...(owner === user ? [] : [{ id: actionId({ do: 'ask-approval', to: owner, url: item.url }), label: 'Request Approval' }]),
            approveItem(owner, item, !othersOnly),
          ],
        };
      }),
    }));
  };

  // a user's pull requests and deployments, each grouped by repository
  const kinds = (owner: string, items: Item[]): TrayMenuItem[] => {
    const pullRequests = items.filter(item => item.kind === 'pull-request');
    const deployments = items.filter(item => item.kind === 'deployment');
    return [
      {
        type: 'submenu', label: `Pull Requests (${pullRequests.length})`,
        enabled: usable && pullRequests.length > 0, submenu: grouped(owner, pullRequests),
      },
      {
        type: 'submenu', label: `Deployments (${deployments.length})`,
        enabled: usable && deployments.length > 0, submenu: grouped(owner, deployments),
      },
    ];
  };

  return [
    ...(ghMissing ? [
      {
        type: 'submenu', label: 'gh missing', enabled: !busy, submenu: [
          { id: 'gh-check', label: 'Check Again...' },
          { id: 'gh-download', label: 'Download...' },
        ],
      },
    ] satisfies TrayMenuItem[] : []),
    // first, who this is checking for - and a way in, if gh isn't signed in
    ...(ghMissing || signedIn === undefined ? [] : [signedIn
      ? {
        type: 'submenu', label: `Logged in as ${user}`, submenu: [
          { type: 'separator' },
          { id: 'notification-settings', label: 'GitHub Notification settings...' },
          { id: 'notifications', label: 'GitHub Notifications...' },
          { id: 'approvals', label: 'Approval UI...' },
          { id: 'log-viewer', label: 'Log Viewer...' },
          { type: 'separator' },
          { type: 'checkbox', id: 'auto-mark-done', label: 'Automatically Mark as Done', checked: config.autoMarkDone },
          // the provider's account, while it's signed in
          ...(account && accountStatus === 'signed-in' ? [
            { type: 'separator' },
            { id: 'provider-logout', label: `Logout of ${providerName(provider!)}` },
          ] satisfies TrayMenuItem[] : []),
        ],
      }
      : signingIn
        ? { id: 'signing-in', label: `Logging in to GitHub (${user})…`, enabled: false }
        : { id: 'sign-in', label: `Login to GitHub (${user})...`, enabled: !busy }] satisfies TrayMenuItem[]),
    // at the top, so refreshing is always right there
    { id: 'refresh', label: checkNowLabel(), enabled: usable },
    { type: 'separator' },
    // a provider's account to sign in to first - where the others will be
    ...(signedIn && account && accountStatus !== 'signed-in' ? [accountStatus === 'signing-in'
      ? { id: 'provider-logging-in', label: `Logging in to ${providerName(provider!)}…`, enabled: false }
      : { id: 'provider-login', label: `Login to ${providerName(provider!)}...`, enabled: !busy },
    ] satisfies TrayMenuItem[] : []),
    ...(online ? [
      {
        type: 'submenu', label: `Users (${peers.length})`, enabled: usable && peers.length > 0,
        submenu: peers.map(peer => ({
          type: 'submenu', label: `${peer.user} (${peer.items.length})`, submenu: [
            { id: actionId({ do: 'ask-refresh', to: peer.user }), label: 'Request Refresh' },
            { type: 'separator' },
            ...kinds(peer.user, peer.items),
          ],
        })),
      },
    ] satisfies TrayMenuItem[] : []),
    ...(signedIn ? [
      ...kinds(user, mine()),
      { type: 'separator' },
    ] satisfies TrayMenuItem[] : []),
    // always there, whatever else is going on
    { id: 'quit', label: `Quit ${appName}` },
  ];
}

const tray = await host.createTray({ icon: icons.syncing, tooltip: `Checking ${user}'s inbox…`, menu: menu() });
const render = (changes: Partial<TrayParams> = {}) => tray.update({ ...changes, menu: menu() });

// signed in as this user, with a share: the tray joins the others - they see
// it, connect to it for its items and to ask it things, and it connects to
// them for theirs
function goOnline() {
  if (rtc || !signaling || (account && accountStatus !== 'signed-in')) return;
  rtc = createRtcHost<TrayInfo>(signaling, {
    deviceId: config.deviceId,
    name: user,
    info: { user, session },
    accept: channel => {
      // from a tray that says whose it is - this user's own others aside
      const from = userOf(channel.label);
      if (!from || from === user) return false;
      serve(channel, from, store, {
        refresh: from => {
          log(`${from} asked for a refresh`);
          void refresh();
        },
        requestApproval: (from, item) => void approvalRequested(from, item).catch(async error => {
          await render({ tooltip: `${from} asked for an approval, but it couldn't be shown: ${firstLine(error)}` });
        }),
        approve: approveFor,
      });
    },
    // someone coming or going
    onDevices: follow,
    onError: reason => { if (reason) log(`sharing through ${providerLabel(provider!)}: ${reason}`); },
    // the account's sign-in refused: it's stopped itself, and waits for one
    onStopped: reason => {
      log(`stopped sharing: ${reason}`);
      void goOffline().then(() => render());
    },
  });
  void devices.set({ status: { ...devices.state.status, online: true } });
  log(`sharing through ${providerLabel(provider!)}`);
}

// not signed in (or leaving): every connection goes - theirs to this tray and
// this tray's to them - so everyone drops it straight away, and it's marked
// offline
async function goOffline() {
  if (!rtc) return;
  const stopping = rtc;
  rtc = undefined;
  void devices.set({ status: { ...devices.state.status, online: false } });
  for (const deviceId of [...links.keys()]) unlink(deviceId);
  await stopping.stop();
  log('stopped sharing');
}

let leaving = false;
async function leave() {
  if (leaving) return;
  leaving = true;
  clearTimeout(nextPoll);
  await goOffline();
  auth?.dispose();
  host.dispose();
  process.exit(0);
}
host.onClose(() => void leave());
process.once('SIGINT', () => void leave());
process.once('SIGTERM', () => void leave());

// someone asking this user to approve one of their items - clicked, it opens
async function approvalRequested(from: string, item: SentItem) {
  log(`${from} asked for approval of ${item.kind}: ${item.title}`);
  const kind = item.kind === 'pull-request' ? 'a pull request' : 'a deployment';
  const notification = await host.showNotification({ title: `${from} asks you to approve ${kind}`, body: item.title });
  if (await notification.closed === 'click') await host.shell.openExternal(item.url);
}

// someone having this tray approve one of this user's items, with this
// user's account - who it was for goes in the approval, and this user is told
async function approveFor(from: string, url: string, environment?: number) {
  const found = store.state.items[url];
  if (!found) throw new Error(`that isn't waiting on ${user} any more`);
  let what: string;
  try {
    what = await approveItem(found, environment, `Auto approved by ${user} on behalf of ${from}`);
  } catch (error) {
    log(`${from} couldn't have this tray approve #${found.number} ${found.title}: ${firstLine(error)}`);
    throw error;
  }
  log(`${from} had this tray approve ${what}`);
  void host.showNotification({ title: `${from} approved this as you`, body: found.title }).catch(() => { });
  void refresh(true);
}

// One refresh at a time, whoever asks. Asks while one runs make one more
// after it, however many there are - broadcasting if any of them asked to.
// However a refresh goes, the next poll is set after it.
const refreshing = coalesce<boolean>(async broadcast => {
  let seconds = DEFAULT_POLL_SECONDS;
  try {
    seconds = await refreshOnce(broadcast);
  } catch (error) {
    log(`refresh failed: ${firstLine(error)}`);
  } finally {
    if (!leaving) nextPoll = setTimeout(() => void refresh(), seconds * 1000);
  }
}, (queued, next) => queued || next);
const refresh = (broadcast = false) => refreshing(broadcast);

// asks every other running tray to refresh
function broadcastRefresh() {
  for (const link of connected()) void link.tray!.request.refresh().catch(() => { });
}

// the connections follow who's online: anyone gone, or run again, is hung up
// on - and anyone not connected to yet is. This user's own other trays have
// the same items, so they're left be.
function follow() {
  const devices = rtc?.devices ?? {};
  for (const [deviceId, { session: theirs }] of [...links]) {
    const device = devices[deviceId];
    if (!device?.online || device.info?.session !== theirs) unlink(deviceId);
  }
  for (const [deviceId, device] of Object.entries(devices)) {
    const info = device.info;
    if (deviceId === config.deviceId || !device.online || !info?.user || !info.session || info.user === user) continue;
    if (!links.has(deviceId)) void link(deviceId, info);
  }
  void render();
}

// connects to another tray, once a run of it, and follows its items: listed
// while it's open, and not tried again if it fails or closes until it runs
// again
async function link(deviceId: string, info: TrayInfo) {
  const entry: Link = { user: info.user, session: info.session };
  links.set(deviceId, entry);
  if (!rtc) return;
  let connection: Awaited<ReturnType<typeof connect>>;
  try {
    connection = await connect(rtc, deviceId, user);
  } catch (error) {
    log(`couldn't connect to ${info.user}: ${firstLine(error)}`);
    return;
  }
  // hung up on, or gone offline, while it connected
  if (links.get(deviceId) !== entry || !rtc) return connection.close();
  entry.tray = connection.tray;
  entry.close = connection.close;
  connection.onClose(() => {
    if (entry.tray !== connection.tray) return;
    entry.tray = undefined;
    forget(deviceId);
    log(`${info.user} hung up`);
    void render();
  });
  try {
    // their items as they are, and every change to them after - the first
    // time whole, as the device
    await connection.tray.state.items.subscribe((items, ops) => {
      if (entry.tray !== connection.tray) return;
      changeDevices(devices.state.devices[deviceId]
        ? prefixOps(ops, pointer(deviceId, 'items'))
        : [{ op: 'add', path: pointer(deviceId), value: { user: info.user, items } }]);
      void render();
    });
  } catch (error) {
    log(`couldn't follow ${info.user}'s items: ${firstLine(error)}`);
    return connection.close();
  }
  log(`connected to ${info.user}`);
}

function unlink(deviceId: string) {
  const entry = links.get(deviceId);
  links.delete(deviceId);
  if (!entry) return;
  entry.tray = undefined;
  forget(deviceId);
  entry.close?.();
}

// gh's token for this user - or, if gh is missing or not signed in as them,
// what the tray says instead
async function signInState(): Promise<{ ghToken: string } | { status: Partial<TrayParams> }> {
  ghMissing = !(await ghInstalled());
  if (ghMissing) return { status: { icon: icons.clear, tooltip: 'gh isn\'t installed' } };
  const ghToken = await tokenFor(user);
  signedIn = !!ghToken;
  if (!ghToken) return { status: { icon: icons.clear, tooltip: `Log in to GitHub as ${user} to check` } };
  return { ghToken };
}

// this user's inbox, served to the others - who hear of each change as it's
// made - and kept for next time
async function scanOwn(ghToken: string): Promise<{ status: Partial<TrayParams> }> {
  const scanned = await inbox.scan(ghToken, config.autoMarkDone);
  if (scanned.markedDone > 0) log(`marked ${scanned.markedDone} finished notification(s) done`);
  if (scanned.markDoneError) log(`couldn't mark some notifications done: ${scanned.markDoneError}`);
  if (scanned.searchError) log(`couldn't search for review requests: ${scanned.searchError}`);
  pollSeconds = scanned.pollSeconds;
  const items = byUrl(scanned.items);
  if (JSON.stringify(items) !== JSON.stringify(store.state.items)) {
    await store.set({ items });
    await writeAtomic(itemsFile, `${JSON.stringify(items, null, 2)}\n`);
  }

  // the icon is for what this user can approve; the rest is only told
  const othersOnly = scanned.items.filter(item => item.kind === 'pull-request' && item.othersOnly).length;
  const waiting = scanned.items.length - othersOnly;
  const more = othersOnly > 0 ? `, ${othersOnly} needing someone else` : '';
  return {
    status: waiting > 0
      ? { icon: icons.waiting, tooltip: `${waiting} waiting for ${user}${more}` }
      : { icon: icons.clear, tooltip: `Nothing waiting for ${user}${more}` },
  };
}

// looks at this user's inbox. Asked for by Check Now
// (here or anywhere), it asks every other tray to as well. Says how long to
// leave it before the next poll.
async function refreshOnce(broadcast: boolean): Promise<number> {
  clearTimeout(nextPoll);
  await render({ icon: icons.syncing });

  // until gh is signed in as this user, the tray takes no part: it isn't
  // seen, sees nobody - only a way to log in
  const state = await signInState().catch(error => ({
    status: { icon: icons.clear, tooltip: `Couldn't check: ${firstLine(error)}` },
  }));
  if (!('ghToken' in state)) {
    await goOffline();
    await render(state.status);
    return DEFAULT_POLL_SECONDS;
  }
  try {
    goOnline();
  } catch (error) {
    log(`couldn't start sharing: ${firstLine(error)}`);
    await render({ icon: icons.clear, tooltip: `Couldn't start sharing: ${firstLine(error)}` });
    return DEFAULT_POLL_SECONDS;
  }

  let status: Partial<TrayParams> = {};
  let reason: string | undefined;
  try {
    ({ status } = await scanOwn(state.ghToken));
  } catch (error) {
    reason = firstLine(error);
  }
  if (reason) log(`refresh failed: ${reason}`);
  // what it cost - logged when that's news: anything costing quota, or a
  // different number of requests than last time - and kept in config.json
  const { asked, paid } = github.count();
  if (paid.length > 0 || asked !== config.lastRefresh?.requests)
    log(`refresh: ${asked} requests, ${paid.length} costing quota${paid.length > 0 ? `: ${paid.join(', ')}` : ''}`);
  const before = JSON.stringify([config.lastRefresh?.requests, config.lastRefresh?.quotaCosting, config.rateLimit]);
  config.lastRefresh = { at: new Date().toISOString(), requests: asked, quotaCosting: paid.length };
  config.rateLimit = github.rateLimit ?? config.rateLimit;
  if (JSON.stringify([asked, paid.length, config.rateLimit]) !== before)
    await saveConfig().catch(error => log(`couldn't save the settings: ${firstLine(error)}`));
  await render({
    icon: icons.clear,
    ...status,
    ...(reason ? { tooltip: `Couldn't check: ${reason}` } : {}),
  });
  // the others hear of this user's items changing as they do; only Check Now
  // has them all look at GitHub again too
  if (broadcast) broadcastRefresh();
  await github.save().catch(error => log(`couldn't save the cache: ${firstLine(error)}`));
  return pollSeconds;
}

// something asked for from the menu, with the menu off while it runs
async function operation(work: () => Promise<void>) {
  if (busy) return;
  busy = true;
  await render();
  try {
    await work();
  } finally {
    busy = false;
    await render();
  }
}

// gh's own device-code sign-in, run behind the scenes: a dialog shows the
// code, and its one button copies it and opens GitHub in the system browser,
// where they may well be signed in already. gh stores the account once it's
// approved there.
async function signIn() {
  if (signingIn) return;
  signingIn = true;
  await render();
  try {
    const login = await startLogin();
    try {
      const dialog = await host.openDialog({
        type: 'info',
        message: login.code,
        detail: `Enter this code on GitHub, signed in as ${user}, to let ${appName} check it for you.`,
        buttons: ['Copy to Clipboard and Open Browser', 'Cancel'],
        defaultId: 0,
        // Escape, or closing it, cancels rather than going ahead
        cancelId: 1,
      });
      if ((await dialog.closed).response === 1) {
        log('login cancelled');
        login.cancel();
        return;
      }
      await host.clipboard.writeText(login.code);
      await host.shell.openExternal(login.url);
    } catch (error) {
      login.cancel();
      throw error;
    }
    if (!(await login.done)) throw new Error('GitHub login didn\'t finish');
    if (!(await tokenFor(user))) throw new Error(`gh logged in, but not as ${user}`);
    log('logged in');
  } catch (error) {
    log(`login failed: ${firstLine(error)}`);
    await render({ tooltip: `Couldn't log in: ${firstLine(error)}` });
  } finally {
    signingIn = false;
    await refresh();
  }
}

// turned on, the next refresh looks over the whole inbox - done items too -
// so what finished before is marked done as well
async function toggleAutoMarkDone() {
  config.autoMarkDone = !config.autoMarkDone;
  await saveConfig().catch(error => log(`couldn't save the settings: ${firstLine(error)}`));
  log(`automatically mark as done: ${config.autoMarkDone ? 'on' : 'off'}`);
  await render();
  // a scan reads it as it starts: one running now goes on as it was, and the
  // next looks over the whole inbox
  if (config.autoMarkDone) {
    inbox.forget();
    await refresh();
  }
}

// a window there's one of at a time: asking again brings the one that's open
// to the front
function single(what: string, open: () => Promise<RemoteWindow>) {
  let opened: Promise<RemoteWindow> | undefined;
  return () => {
    if (opened) {
      void opened.then(window => window.focus()).catch(() => { });
      return;
    }
    const opening = opened = open();
    void opening
      .then(window => window.closed.catch(() => { }), error => log(`couldn't show ${what}: ${firstLine(error)}`))
      .finally(() => { if (opened === opening) opened = undefined; });
  };
}

// the log, tailed
const showLog = single('the log', () => host.open(logViewer, { file: logFile(host.params.userData), title: `${appName} log` }));
// everyone's items
const showApprovals = single('approvals', () => host.open(approvalsWindow, { store: devices, title: appName }));

tray.onEvent(event => {
  if (event.event !== 'menu-item') return;
  const { item } = event;
  if (item === 'quit') return void leave();
  // Check Now searches for review requests too - polls only read the inbox
  if (item === 'refresh' || item === 'gh-check') {
    inbox.search();
    return void operation(() => refresh(true));
  }
  if (item === 'gh-download') return void host.shell.openExternal(GH_DOWNLOAD);
  if (item === 'sign-in') return void signIn();
  if (item === 'notification-settings') return void host.shell.openExternal(NOTIFICATION_SETTINGS);
  if (item === 'notifications') return void host.shell.openExternal(NOTIFICATIONS);
  if (item === 'auto-mark-done') return void toggleAutoMarkDone();
  if (item === 'log-viewer') return void showLog();
  if (item === 'approvals') return void showApprovals();
  if (item === 'provider-login') return void providerLogin();
  if (item === 'provider-logout') return void operation(providerLogout);
  if (!item.startsWith('{')) return;

  const action = JSON.parse(item) as Action;
  switch (action.do) {
    case 'view':
      return void host.shell.openExternal(action.url);
    case 'approve': {
      const found = store.state.items[action.url];
      if (!found) return;
      return void operation(() => approveOwn(found, action.environment));
    }
    case 'ask-refresh': {
      const trays = traysOf(action.to);
      if (!trays.length) return;
      return void Promise.all(trays.map(tray => tray.request.refresh())).then(
        () => log(`asked ${action.to} to refresh`),
        error => render({ tooltip: `Couldn't reach ${action.to}: ${firstLine(error)}` }),
      );
    }
    case 'ask-approval': {
      // every one of their trays tells them - whichever machine they're at
      const found = itemOf(action.to, action.url);
      const trays = traysOf(action.to);
      if (!found || !trays.length) return;
      // what goes to the other tray is just what it is and where
      const { kind, title, url } = found;
      return void Promise.any(trays.map(tray => tray.request.requestApproval({ item: { kind, title, url } }))).then(
        () => log(`asked ${action.to} to approve ${kind}: ${title}`),
        async error => {
          log(`couldn't ask ${action.to} to approve ${title}: ${firstLine(error)}`);
          await render({ tooltip: `Couldn't reach ${action.to}: ${firstLine(error)}` });
        },
      );
    }
    case 'approve-as': {
      // just one of their trays - approving is done once
      const found = itemOf(action.to, action.url);
      const [peer] = traysOf(action.to);
      if (!found || !peer) return;
      const what = `#${found.number} ${found.title} (${found.repo})`;
      return void operation(async () => {
        try {
          await peer.request.approve({ url: action.url, environment: action.environment });
          log(`had ${action.to} approve ${what}`);
        } catch (error) {
          log(`couldn't have ${action.to} approve ${what}: ${firstLine(error)}`);
          await render({ tooltip: `Couldn't approve as ${action.to}: ${firstLine(error)}` });
        }
      });
    }
  }
});

// approves a pull request, or a deployment to one environment, with this
// user's account - saying what it approved
async function approveItem(item: Item, environmentId: number | undefined, message: string) {
  const what = `#${item.number} ${item.title} (${item.repo})`;
  const ghToken = await tokenFor(user);
  if (!ghToken) throw new Error(`gh isn't signed in as ${user}`);
  if (item.kind === 'deployment') {
    const environment = item.environments.find(each => each.id === environmentId);
    if (!environment) throw new Error('that environment isn\'t waiting any more');
    await approveDeployment(ghToken, item, environment, message);
    return `deployment to ${environment.name}: ${what}`;
  }
  await approvePullRequest(ghToken, item.url, message);
  return `pull request: ${what}`;
}

// this user approving one of their own from the menu - then everyone looks
// again: it should drop off
async function approveOwn(item: Item, environmentId?: number) {
  try {
    log(`approved ${await approveItem(item, environmentId, `Auto approved by ${user} via ${appName}`)}`);
  } catch (error) {
    const message = firstLine(error);
    log(`couldn't approve #${item.number} ${item.title} (${item.repo}): ${message}`);
    await render({ tooltip: `Couldn't approve: ${message}` });
    return;
  }
  await refresh(true);
}

// the provider's account: signed in to in a window the broker opens, and
// out of here - either way the broker says so, and the tray follows
async function providerLogin() {
  if (!auth || !account) return;
  accountStatus = 'signing-in';
  await render();
  try {
    await auth.request.getToken({ provider: account, interactive: true });
    log(`logged in to ${providerName(provider!)}`);
  } catch (error) {
    log(`couldn't log in to ${providerName(provider!)}: ${firstLine(error)}`);
    await render({ tooltip: `Couldn't log in to ${providerName(provider!)}: ${firstLine(error)}` });
  } finally {
    // whatever the broker says now, even if it had nothing new to say
    followAccount(auth.state.providers.current);
  }
}

async function providerLogout() {
  if (!auth || !account) return;
  await goOffline();
  await auth.request.signOut({ provider: account });
  log(`logged out of ${providerName(provider!)}`);
}

// the broker's sign-in to the provider's account, kept up with: signed in,
// the tray joins the others (once gh is too); signed out, it leaves them
function followAccount(providers: Record<string, ProviderStatus> | undefined) {
  accountStatus = (account && providers?.[providerKey(account)]?.status) || 'signed-out';
  if (accountStatus === 'signed-in') {
    if (signedIn) goOnline();
  } else void goOffline();
  void render();
}
if (auth) await auth.state.providers.subscribe(followAccount);

void operation(() => refresh(true));
