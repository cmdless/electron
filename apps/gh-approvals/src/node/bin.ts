#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { UIHost } from '@cmdless/ui-sdk/node';
import type { RemoteWindow, TrayMenuItem, TrayParams } from '@cmdless/ui-sdk/node';
import { ghInstalled, startLogin, tokenFor } from './accounts.js';
import { approveDeployment, approvePullRequest } from './approvals.js';
import { listUsers, OwnItems, readItems, readUserFile, removeUserFile, writeAtomic, writeUserFile } from './files.js';
import type { Item, UserFile } from './files.js';
import { GitHub } from './github.js';
import type { RateLimit } from './github.js';
import { DEFAULT_POLL_SECONDS, Inbox } from './inbox.js';
import { listen, newToken, requestRefresh, sendTo } from './peers.js';
import type { SentItem } from './peers.js';
import { createLog, logFile } from './log.js';
import { coalesce, firstLine } from './util.js';
import { logViewer } from './logViewer.js';

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
// --data <folder>: the folder every user's tray shares - each writes its own
//   {user} folder there, and reads everyone else's. A data folder in the
//   app's own userData unless it's given.
// --org <owner>: only what's in this owner's repositories (repeatable)
const { values: args } = parseArgs({
  options: { user: { type: 'string' }, data: { type: 'string' }, org: { type: 'string', multiple: true } },
});
if (!args.user) {
  console.error(`usage: ${appName} --user <github login> [--data <folder>] [--org <owner>]...`);
  process.exit(2);
}
const user = args.user;
const orgs = (args.org ?? []).map(org => org.toLowerCase());

// the app's own host, named after the package - running this again joins the
// one that's already up rather than starting another
const host = await UIHost.create({ app: pkg.name });

// it's already running, tray and all, so there's nothing more to do here
if (!host.params.hasSingleInstanceLock) {
  host.dispose();
  process.exit(0);
}

// a log in the app's own userData, wherever --data points
const log = createLog(host.params.userData);

const folder = path.resolve(args.data ?? path.join(host.params.userData, 'data'));
await fs.promises.mkdir(path.join(folder, user), { recursive: true });
log(`started, with data in ${folder}`);

// GitHub, asked conditionally - what it last answered is kept in userData,
// this machine's own business
const github = new GitHub(path.join(host.params.userData, 'github-cache.json'), appName);
await github.load();
const inbox = new Inbox(github, user, orgs);

// this machine's own settings, in userData - and, beside them, what the last
// refresh cost and where GitHub's rate limit stood after it
type Config = {
  autoMarkDone: boolean;
  lastRefresh?: { at: string; requests: number; quotaCosting: number };
  rateLimit?: RateLimit;
};
const configFile = path.join(host.params.userData, 'config.json');
const config: Config = {
  autoMarkDone: false,
  ...JSON.parse(await fs.promises.readFile(configFile, 'utf8').catch(() => '{}')) as Partial<Config>,
};
const saveConfig = () => writeAtomic(configFile, `${JSON.stringify(config, null, 2)}\n`);

// this user's items: what their folder has from before, until the first scan
const own = new OwnItems(folder, user);
let mine: Item[] = await own.load();

// everyone else whose tray is running - their user.json, and their items as
// their folder has them
type Other = { user: string; file: UserFile; items: Item[] };
let others = new Map<string, Other>();
// trays that didn't answer, by user and token: a tray that stopped without
// taking its user.json away. Listed again once they answer, or restart.
const unreachable = new Set<string>();
const reachKey = ({ user: name, file }: Other) => `${name}:${file.token}`;
const running = () => [...others.values()]
  .filter(other => !unreachable.has(reachKey(other)))
  .sort((a, b) => a.user.localeCompare(b.user));

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

// what a menu item does when it's clicked, as its id: `owner` is whose item
// it is - this user's, or someone else's
type Action =
  | { do: 'view'; url: string }
  | { do: 'send'; url: string; to: string }
  | { do: 'approve'; owner: string; url: string; environment?: number }
  | { do: 'ask-refresh'; to: string };
const actionId = (action: Action) => JSON.stringify(action);

const titled = (title: string) => title.length > TITLE_LENGTH ? `${title.slice(0, TITLE_LENGTH - 1)}…` : title;

// the tray's listener, its token, and where it says it is - only while gh
// is signed in as this user, which is when the tray takes part at all
let listener: Awaited<ReturnType<typeof listen>> | undefined;
let token = '';
let endpoint = { host: os.hostname(), port: 0 };

// GitHub's rate limit: what's left of it this hour (of how much), and what
// the last refresh cost (of how many requests it made)
function quotaLabel() {
  const { lastRefresh, rateLimit } = config;
  const total = rateLimit ? `${rateLimit.remaining.toLocaleString()} (${rateLimit.limit.toLocaleString()})` : '?';
  const last = lastRefresh ? `${lastRefresh.quotaCosting} (${lastRefresh.requests})` : '?';
  return `Quota - total: ${total}, last: ${last}`;
}

function menu(): TrayMenuItem[] {
  const usable = !busy && !ghMissing;
  // nothing of anyone's shows until gh is signed in as this user
  const online = listener !== undefined;
  const peers = running();

  // approving it - a deployment one environment at a time
  const approveItem = (owner: string, item: Item): TrayMenuItem => item.kind === 'deployment'
    ? {
      type: 'submenu', label: 'Auto Approve', submenu: item.environments.map(environment => ({
        id: actionId({ do: 'approve', owner, url: item.url, environment: environment.id }), label: environment.name,
      })),
    }
    : { id: actionId({ do: 'approve', owner, url: item.url }), label: 'Auto Approve' };

  // something only someone else can approve goes to someone whose tray is
  // running
  const sendItem = ({ url }: Item): TrayMenuItem => ({
    type: 'submenu', label: `Send To (${peers.length})`, enabled: peers.length > 0,
    submenu: peers.map(peer => ({ id: actionId({ do: 'send', url, to: peer.user }), label: peer.user })),
  });

  // grouped by repository; each one offers approving it, or - marked with a *
  // - sending it to someone who can, then opening it on GitHub
  const grouped = (owner: string, items: Item[]): TrayMenuItem[] => {
    const byRepo = new Map<string, Item[]>();
    for (const item of items) byRepo.set(item.repo, [...byRepo.get(item.repo) ?? [], item]);
    return [...byRepo].sort(([a], [b]) => a.localeCompare(b)).map(([repo, inRepo]) => ({
      type: 'submenu', label: repo, enabled: usable,
      submenu: inRepo.sort((a, b) => a.number - b.number).map(item => {
        const othersOnly = owner === user && item.kind === 'pull-request' && item.othersOnly;
        return {
          type: 'submenu', label: titled(`${othersOnly ? '*' : ''}#${item.number} ${item.title}`), enabled: usable,
          submenu: [
            othersOnly ? sendItem(item) : approveItem(owner, item),
            { type: 'separator' },
            { id: actionId({ do: 'view', url: item.url }), label: 'View in Browser...' },
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
        type: 'submenu', label: `Logged in as ${user}`, enabled: !busy, submenu: [
          { id: 'listening', label: `Listening on ${endpoint.host}:${endpoint.port}...`, enabled: false },
          { id: 'quota', label: quotaLabel(), enabled: false },
          { type: 'separator' },
          { id: 'notification-settings', label: 'Notification settings...' },
          { id: 'notifications', label: 'Notifications...' },
          { id: 'log-viewer', label: 'Log Viewer...' },
          { type: 'separator' },
          { type: 'checkbox', id: 'auto-mark-done', label: 'Automatically Mark as Done', checked: config.autoMarkDone },
        ],
      }
      : signingIn
        ? { id: 'signing-in', label: `Logging in to GitHub (${user})…`, enabled: false }
        : { id: 'sign-in', label: `Login to GitHub (${user})...`, enabled: !busy }] satisfies TrayMenuItem[]),
    // at the top, so refreshing is always right there
    { id: 'refresh', label: 'Check now', enabled: usable },
    { type: 'separator' },
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
      ...kinds(user, mine),
      { type: 'separator' },
    ] satisfies TrayMenuItem[] : []),
    // always there, whatever else is going on
    { id: 'quit', label: `Quit ${appName}` },
  ];
}

const tray = await host.createTray({ icon: icons.syncing, tooltip: `Checking ${user}'s inbox…`, menu: menu() });
const render = (changes: Partial<TrayParams> = {}) => tray.update({ ...changes, menu: menu() });

// user.json says this tray is running, where, and when its files last
// changed - keeping the time from before if they haven't since
let lastUpdatedAt = (await readUserFile(folder, user))?.lastUpdatedAt ?? new Date().toISOString();
const writeOwnUserFile = () => writeUserFile(folder, user, { token, endpoint, lastUpdatedAt });

// signed in as this user: the tray starts listening - other trays ask it to
// refresh, and send it things - and says where in user.json
async function goOnline() {
  if (listener) return;
  token = newToken();
  listener = await listen(token, {
    refresh: from => {
      log(`${from} asked for a refresh`);
      void refresh();
    },
    send: (from, item) => void received(from, item).catch(async error => {
      await render({ tooltip: `${from} sent something, but it couldn't be shown: ${firstLine(error)}` });
    }),
  });
  endpoint = { host: os.hostname(), port: listener.port };
  await writeOwnUserFile();
  log(`listening on ${endpoint.host}:${endpoint.port}`);
}

// not signed in (or leaving): user.json goes first, then the others are asked
// to look again, so nobody lists this tray once it's gone
async function goOffline() {
  if (!listener) return;
  const closing = listener;
  listener = undefined;
  await removeUserFile(folder, user).catch(() => { });
  await Promise.allSettled([...others.values()].map(other => requestRefresh(other.file, user)));
  others = new Map();
  closing.server.close();
  log('stopped listening');
}

let leaving = false;
async function leave() {
  if (leaving) return;
  leaving = true;
  clearTimeout(nextPoll);
  await goOffline();
  host.dispose();
  process.exit(0);
}
host.onClose(() => void leave());
process.once('SIGINT', () => void leave());
process.once('SIGTERM', () => void leave());

async function received(from: string, item: SentItem) {
  log(`${from} sent ${item.kind}: ${item.title}`);
  const kind = item.kind === 'pull-request' ? 'a pull request' : 'a deployment';
  const notification = await host.showNotification({ title: `${from} sent you ${kind}`, body: item.title });
  if (await notification.closed === 'click') await host.shell.openExternal(item.url);
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

// asks every other running tray to refresh - and notes the ones that don't
// answer, listing them again once they do
function broadcastRefresh() {
  const all = [...others.values()];
  void Promise.all(all.map(other => requestRefresh(other.file, user).then(
    () => unreachable.delete(reachKey(other)),
    () => unreachable.add(reachKey(other)),
  ))).then(() => render());
}

// the users' folders: who's running, and - for anyone whose files changed
// since last time - what they have
async function scanUsers() {
  const names = (await listUsers(folder)).filter(name => name !== user);
  const next = new Map<string, Other>();
  await Promise.all(names.map(async name => {
    const file = await readUserFile(folder, name);
    if (!file) return;
    const before = others.get(name);
    const same = before && before.file.lastUpdatedAt === file.lastUpdatedAt && before.file.token === file.token;
    next.set(name, { user: name, file, items: same ? before.items : await readItems(folder, name) });
  }));
  others = next;
  // a tray that's gone, or restarted with a new token, isn't unreachable any more
  const current = new Set([...others.values()].map(reachKey));
  for (const key of unreachable) if (!current.has(key)) unreachable.delete(key);
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

// this user's inbox, written to their folder - whether that changed anything
async function scanOwn(ghToken: string): Promise<{ changed: boolean; status: Partial<TrayParams> }> {
  const scanned = await inbox.scan(ghToken, config.autoMarkDone);
  if (scanned.markedDone > 0) log(`marked ${scanned.markedDone} finished notification(s) done`);
  if (scanned.markDoneError) log(`couldn't mark some notifications done: ${scanned.markDoneError}`);
  pollSeconds = scanned.pollSeconds;
  mine = scanned.items;
  const changed = await own.write(mine);
  if (changed) {
    lastUpdatedAt = new Date().toISOString();
    await writeOwnUserFile();
  }

  // the icon is for what this user can approve; the rest is only told
  const othersOnly = mine.filter(item => item.kind === 'pull-request' && item.othersOnly).length;
  const waiting = mine.length - othersOnly;
  const more = othersOnly > 0 ? `, ${othersOnly} needing someone else` : '';
  return {
    changed,
    status: waiting > 0
      ? { icon: icons.waiting, tooltip: `${waiting} waiting for ${user}${more}` }
      : { icon: icons.clear, tooltip: `Nothing waiting for ${user}${more}` },
  };
}

// looks at everyone's folders and this user's inbox. Asked for by Check now
// (here or anywhere), it asks every other tray to as well; otherwise it only
// does if this user's files changed, so they see it - which settles, since a
// refresh that finds nothing new changes nothing. Says how long to leave it
// before the next poll.
async function refreshOnce(broadcast: boolean): Promise<number> {
  clearTimeout(nextPoll);
  await render({ icon: icons.syncing });

  // until gh is signed in as this user, the tray takes no part: no listener,
  // no user.json, nobody's folders - only a way to log in
  const state = await signInState().catch(error => ({
    status: { icon: icons.clear, tooltip: `Couldn't check: ${firstLine(error)}` },
  }));
  if (!('ghToken' in state)) {
    await goOffline();
    await render(state.status);
    return DEFAULT_POLL_SECONDS;
  }
  try {
    await goOnline();
  } catch (error) {
    log(`couldn't start listening: ${firstLine(error)}`);
    await render({ icon: icons.clear, tooltip: `Couldn't start listening: ${firstLine(error)}` });
    return DEFAULT_POLL_SECONDS;
  }

  const [users, scanned] = await Promise.allSettled([scanUsers(), scanOwn(state.ghToken)]);
  const failed = [users, scanned].find(result => result.status === 'rejected');
  const reason = failed && firstLine(failed.reason);
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
    ...(scanned.status === 'fulfilled' ? scanned.value.status : {}),
    ...(reason ? { tooltip: `Couldn't check: ${reason}` } : {}),
  });
  if (broadcast || (scanned.status === 'fulfilled' && scanned.value.changed)) broadcastRefresh();
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
  if (config.autoMarkDone) {
    inbox.forget();
    await operation(() => refresh());
  }
}

// the log, tailed in a window - one at a time: asking again brings the one
// that's open to the front
let logWindow: Promise<RemoteWindow> | undefined;
function showLog() {
  if (logWindow) {
    void logWindow.then(window => window.focus()).catch(() => { });
    return;
  }
  const opening = logWindow = host.open(logViewer, { file: logFile(host.params.userData), title: `${appName} log` });
  void opening
    .then(window => window.closed.catch(() => { }), error => log(`couldn't show the log: ${firstLine(error)}`))
    .finally(() => { if (logWindow === opening) logWindow = undefined; });
}

// whose items an action's owner means
const itemsOf = (owner: string) => owner === user ? mine : others.get(owner)?.items ?? [];

tray.onEvent(event => {
  if (event.event !== 'menu-item') return;
  const { item } = event;
  if (item === 'quit') return void leave();
  if (item === 'refresh' || item === 'gh-check') return void operation(() => refresh(true));
  if (item === 'gh-download') return void host.shell.openExternal(GH_DOWNLOAD);
  if (item === 'sign-in') return void signIn();
  if (item === 'notification-settings') return void host.shell.openExternal(NOTIFICATION_SETTINGS);
  if (item === 'notifications') return void host.shell.openExternal(NOTIFICATIONS);
  if (item === 'auto-mark-done') return void toggleAutoMarkDone();
  if (item === 'log-viewer') return void showLog();
  if (!item.startsWith('{')) return;

  const action = JSON.parse(item) as Action;
  switch (action.do) {
    case 'view':
      return void host.shell.openExternal(action.url);
    case 'approve': {
      const found = itemsOf(action.owner).find(each => each.url === action.url);
      if (!found) return;
      return void operation(() => approve(found, action.environment));
    }
    case 'ask-refresh': {
      const other = others.get(action.to);
      if (!other) return;
      return void requestRefresh(other.file, user).then(
        () => log(`asked ${other.user} to refresh`),
        error => render({ tooltip: `Couldn't reach ${other.user}: ${firstLine(error)}` }),
      );
    }
    case 'send': {
      const found = mine.find(each => each.url === action.url);
      const other = others.get(action.to);
      if (!found || !other) return;
      // what goes to the other tray is just what it is and where
      const { kind, title, url } = found;
      const sent: SentItem = { kind, title, url };
      return void operation(async () => {
        await sendTo(other.file, user, sent).then(
          () => log(`sent ${sent.kind} to ${other.user}: ${sent.title}`),
          async error => {
            log(`couldn't send to ${other.user}: ${firstLine(error)}`);
            await render({ tooltip: `Couldn't send to ${other.user}: ${firstLine(error)}` });
          });
      });
    }
  }
});

// what an approval says it was
const approvalMessage = `Auto approved by ${user} via ${appName}`;

// approves a pull request, or a deployment to one environment - this user's
// or someone else's - then has everyone look again: it should drop off
async function approve(item: Item, environmentId?: number) {
  const what = `#${item.number} ${item.title} (${item.repo})`;
  try {
    const ghToken = await tokenFor(user);
    if (!ghToken) throw new Error(`gh isn't signed in as ${user}`);
    if (item.kind === 'deployment') {
      const environment = item.environments.find(each => each.id === environmentId);
      if (!environment) throw new Error('that environment isn\'t waiting any more');
      await approveDeployment(ghToken, item, environment, approvalMessage);
      log(`approved deployment to ${environment.name}: ${what}`);
    } else {
      await approvePullRequest(ghToken, item.url, approvalMessage);
      log(`approved pull request: ${what}`);
    }
  } catch (error) {
    const message = firstLine(error);
    log(`couldn't approve ${what}: ${message}`);
    await render({ tooltip: `Couldn't approve: ${message}` });
    return;
  }
  await refresh(true);
}

void operation(() => refresh(true));
