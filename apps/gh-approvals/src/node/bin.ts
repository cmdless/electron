#!/usr/bin/env node

import fs from 'node:fs';
import type { Server } from 'node:net';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { UIHost } from '@cmdless/ui-sdk/node';
import type { TrayMenuItem, TrayParams } from '@cmdless/ui-sdk/node';
import { ghInstalled, startLogin, tokenFor } from './accounts.js';
import { approveDeployment, approvePullRequest, ownPullRequests, pendingDeployments, pushedLastBy, reviewRequests } from './approvals.js';
import type { PendingDeployment } from './approvals.js';
import { probe, readLeads, removeToken, sendTo, serveLead, writeToken } from './leads.js';
import type { Lead, LeadStatus, SentItem } from './leads.js';
import { createLog } from './log.js';

const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { name: string };
const asset = (name: string) => fileURLToPath(new URL(`../../assets/${name}`, import.meta.url));
const icons = { clear: asset('checkTemplate.png'), waiting: asset('alertTemplate.png') };

// the name it goes by, without the package's scope
const appName = pkg.name.replace(/^@[^/]+\//, '');

// how often to look again
const CHECK_EVERY_MS = 2 * 60_000;

// where to send someone who doesn't have gh yet
const GH_DOWNLOAD = 'https://cli.github.com/';

// the account's own notification settings - which go by email, and which to
// the inbox on GitHub - for whoever's signed in to the browser
const NOTIFICATION_SETTINGS = 'https://github.com/settings/notifications';

// how much of a title a menu shows
const TITLE_LENGTH = 60;

// --user <login>: the GitHub account this runs for
// --data <folder>: where leads.json and the leads' tokens live - the app's own
//   userData unless it's given. Being able to write there is what lets a lead
//   take part; with no leads.json there, there are no leads.
const { values: args } = parseArgs({ options: { user: { type: 'string' }, data: { type: 'string' } } });
if (!args.user) {
  console.error(`usage: ${appName} --user <github login> [--data <folder>]`);
  process.exit(2);
}
const user = args.user;

// the app's own host, named after the package - running this again joins the
// one that's already up rather than starting another
const host = await UIHost.create({ app: pkg.name });

// it's already running, tray and all, so there's nothing more to do here
if (!host.params.hasSingleInstanceLock) {
  host.dispose();
  process.exit(0);
}

// the host goes when this does, and this goes when the host does
host.onClose(() => process.exit(0));

// a log in the app's own userData, wherever --data points
const log = createLog(host.params.userData);

const folder = path.resolve(args.data ?? host.params.userData);
const leadsFile = path.join(folder, 'leads.json');
// there to watch, and to write a token into, even before anyone's a lead
await fs.promises.mkdir(folder, { recursive: true });
log(`started, with data in ${folder}`);
// the leads as leads.json last said, read again on every check
let leadList: Lead[] = [];
// this user's own entry, if they're a lead, and everyone else
const me = () => leadList.find(lead => lead.user === user);
const others = () => leadList.filter(lead => lead.user !== user);

// something waiting on this user: a pull request to review, or a deployment
// to approve - with the repository it's in, its number (a pull request's, or
// a run's), and for a deployment, the run and the environments waiting on it
// and whether this user can approve it, or someone else has to
type Approval = SentItem & { repo: string; number: number; deployment?: PendingDeployment; othersOnly?: boolean };

// pull requests: the ones this user can approve (requested of them, and not
// pushed to last by them), and the ones someone else has to (their own, and
// requested ones they pushed to last) - those are what gets sent to someone
let pullRequests: Approval[] = [];
// the deployments the inbox points at that are still waiting on this user
let deployments: Approval[] = [];
let leads: { lead: Lead; status: LeadStatus }[] = [];
// while something asked for from the menu is being done, the menu is off but
// for Quit; checks made on a timer don't turn it off
let busy = false;
// without gh there's nothing to check with: the menu offers to look again,
// or to get it, and the rest stays off
let ghMissing = false;
// whether gh is signed in to this user - unknown until the first check
let signedIn: boolean | undefined;
// a sign-in is going on, in the browser
let signingIn = false;

// what a menu item does when it's clicked, as its id
type Action =
  | { do: 'view'; url: string }
  | { do: 'send'; url: string; to: string }
  | { do: 'approve'; url: string; environment?: number };
const actionId = (action: Action) => JSON.stringify(action);

const titled = (title: string) => title.length > TITLE_LENGTH ? `${title.slice(0, TITLE_LENGTH - 1)}…` : title;

function menu(): TrayMenuItem[] {
  const usable = !busy && !ghMissing;
  const ready = leads.filter(each => each.status === 'ready');

  const leadItems: TrayMenuItem[] = [
    { id: 'lead-add', label: 'Add New...', enabled: usable },
    { type: 'separator' },
    ...leads.map(({ lead, status }) => ({ id: `lead:${lead.user}`, label: `${lead.name} (${status})`, enabled: usable })),
  ];

  // grouped by repository; each one opens on GitHub, or goes to a lead who's
  // ready for it
  // something this user can approve - a deployment one environment at a time
  const approveItem = ({ url, deployment }: Approval): TrayMenuItem => deployment
    ? {
      type: 'submenu', label: 'Auto Approve', submenu: deployment.environments.map(environment => ({
        id: actionId({ do: 'approve', url, environment: environment.id }), label: environment.name,
      })),
    }
    : { id: actionId({ do: 'approve', url }), label: 'Auto Approve' };

  // something only someone else can approve goes to a lead who's ready for it
  const sendItem = ({ url }: Approval): TrayMenuItem => ({
    type: 'submenu', label: `Send To (${ready.length})`, enabled: ready.length > 0,
    submenu: ready.map(({ lead }) => ({ id: actionId({ do: 'send', url, to: lead.user }), label: lead.name })),
  });

  // grouped by repository; each one offers approving it, or - marked with a *
  // - sending it to someone who can, then opening it on GitHub
  const grouped = (approvals: Approval[]): TrayMenuItem[] => {
    const byRepo = new Map<string, Approval[]>();
    for (const approval of approvals) byRepo.set(approval.repo, [...byRepo.get(approval.repo) ?? [], approval]);
    return [...byRepo].sort(([a], [b]) => a.localeCompare(b)).map(([repo, inRepo]) => ({
      type: 'submenu', label: repo, enabled: usable,
      submenu: inRepo.map(approval => ({
        type: 'submenu', label: titled(`${approval.othersOnly ? '*' : ''}#${approval.number} ${approval.title}`), enabled: usable,
        submenu: [
          approval.othersOnly ? sendItem(approval) : approveItem(approval),
          { type: 'separator' },
          { id: actionId({ do: 'view', url: approval.url }), label: 'View in Browser...' },
        ],
      })),
    }));
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
          { id: 'notification-settings', label: 'Notification Settings...' },
        ],
      }
      : signingIn
        ? { id: 'signing-in', label: `Logging in to GitHub (${user})…`, enabled: false }
        : { id: 'sign-in', label: `Login to GitHub (${user})...`, enabled: !busy }] satisfies TrayMenuItem[]),
    // at the top, so refreshing is always right there
    { id: 'refresh', label: 'Check now', enabled: usable },
    { type: 'separator' },
    { type: 'submenu', label: `Leads (${leads.length})`, enabled: usable, submenu: leadItems },
    {
      type: 'submenu', label: `Pull Requests (${pullRequests.length})`,
      enabled: usable && pullRequests.length > 0, submenu: grouped(pullRequests),
    },
    {
      type: 'submenu', label: `Deployments (${deployments.length})`,
      enabled: usable && deployments.length > 0, submenu: grouped(deployments),
    },
    { type: 'separator' },
    // always there, whatever else is going on
    { id: 'quit', label: `Quit ${appName}` },
  ];
}

const tray = await host.createTray({ icon: icons.clear, tooltip: `Checking ${user}'s reviews…`, menu: menu() });
const render = (changes: Partial<TrayParams> = {}) => tray.update({ ...changes, menu: menu() });

// as a lead, this run's token is how the other leads reach it - and what they
// send shows up as a notification, opening it when it's clicked. Someone who
// isn't a lead can still send, but can't be sent to.
let listener: Server | undefined;

async function becomeLead() {
  log('became a lead: listening for the other leads');
  const token = await writeToken(folder, user);
  listener = await serveLead(token, (from, item) => void received(from, item).catch(async error => {
    await render({ tooltip: `${from} sent something, but it couldn't be shown: ${(error as Error).message}` });
  }));
}

// no longer a lead: the listener stops, and the token goes with it, so the
// others see this one as offline straight away
async function stopBeingLead() {
  log('no longer a lead: stopped listening');
  const closing = listener;
  listener = undefined;
  await new Promise<void>(resolve => closing?.close(() => resolve()) ?? resolve());
  await removeToken(folder, user);
}

// reads leads.json again, and starts or stops listening if this user has
// joined or left it
async function loadLeads() {
  leadList = await readLeads(leadsFile);
  if (me() && !listener) await becomeLead();
  else if (!me() && listener) await stopBeingLead();
}

async function received(from: string, item: SentItem) {
  log(`${from} sent ${item.kind}: ${item.title}`);
  const kind = item.kind === 'pull-request' ? 'a pull request' : 'a deployment';
  const notification = await host.showNotification({ title: `${from} sent you ${kind}`, body: item.title });
  if (await notification.closed === 'click') await host.shell.openExternal(item.url);
}

// one check at a time, whoever asks - a second ask while one runs shares it
let checking: Promise<void> | undefined;
const refresh = () => checking ??= check().finally(() => checking = undefined);

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

// the leads as they are now, and whether each other lead's gh-approvals
// answers
async function checkLeads() {
  await loadLeads();
  const current = others();
  const statuses = await Promise.all(current.map(lead => probe(folder, lead)));
  const before = new Map(leads.map(({ lead, status }) => [lead.user, status]));
  leads = current.map((lead, index) => ({ lead, status: statuses[index] }));
  for (const { lead, status } of leads)
    if (before.get(lead.user) !== status) log(`${lead.name}: ${before.get(lead.user) ?? 'new'} -> ${status}`);
  for (const [gone] of before) if (!current.some(lead => lead.user === gone)) log('a lead was removed');
}

// a check mark when nothing's waiting on this user, an exclamation mark when
// something is - and if it can't tell, it says why
async function checkApprovals(): Promise<Partial<TrayParams>> {
  ghMissing = !(await ghInstalled());
  if (ghMissing) {
    pullRequests = deployments = [];
    return { icon: icons.clear, tooltip: 'gh isn\'t installed' };
  }
  const github = await tokenFor(user);
  signedIn = !!github;
  if (!github) {
    pullRequests = deployments = [];
    return { icon: icons.clear, tooltip: `Sign in to gh as ${user} to check` };
  }
  const [reviews, own, pending] = await Promise.all([
    reviewRequests(github), ownPullRequests(github), pendingDeployments(github),
  ]);
  const asApproval = ({ number, title, url, repository }: (typeof reviews)[number]): Approval => ({
    kind: 'pull-request', title, url, repo: repository.nameWithOwner, number,
  });
  // a requested pull request this user pushed to last isn't theirs to approve
  const rules = new Map<string, Promise<boolean>>();
  const pushedLast = await Promise.all(reviews.map(review => pushedLastBy(github, user, review.url, rules).catch(() => false)));
  pullRequests = [
    ...reviews.map((review, index) => ({ ...asApproval(review), othersOnly: pushedLast[index] })),
    ...own.map(review => ({ ...asApproval(review), othersOnly: true })),
  ];
  deployments = pending.map(deployment => ({
    kind: 'deployment', title: deployment.title, url: deployment.url, repo: deployment.repo,
    number: deployment.runNumber, deployment,
  }));
  // the icon is for what this user can approve; the rest is only told
  const othersOnly = [...pullRequests, ...deployments].filter(each => each.othersOnly).length;
  const waiting = pullRequests.length + deployments.length - othersOnly;
  const more = othersOnly > 0 ? `, ${othersOnly} needing someone else` : '';
  return waiting > 0
    ? { icon: icons.waiting, tooltip: `${waiting} waiting for ${user}${more}` }
    : { icon: icons.clear, tooltip: `Nothing waiting for ${user}${more}` };
}

async function check() {
  const [approvals, leadsChecked] = await Promise.allSettled([checkApprovals(), checkLeads()]);
  const failed = [approvals, leadsChecked].find(result => result.status === 'rejected');
  if (failed) log(`check failed: ${(failed.reason as Error).message.split('\n')[0]}`);
  await render({
    ...(approvals.status === 'fulfilled' ? approvals.value : {}),
    ...(failed ? { tooltip: `Couldn't check: ${(failed.reason as Error).message.split('\n')[0]}` } : {}),
  });
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
    log(`login failed: ${(error as Error).message.split('\n')[0]}`);
    await render({ tooltip: `Couldn't log in: ${(error as Error).message.split('\n')[0]}` });
  } finally {
    signingIn = false;
    await refresh();
  }
}

tray.onEvent(event => {
  if (event.event !== 'menu-item') return;
  const { item } = event;
  if (item === 'quit') return host.dispose();
  if (item === 'refresh' || item === 'gh-check') return void operation(refresh);
  if (item === 'gh-download') return void host.shell.openExternal(GH_DOWNLOAD);
  if (item === 'sign-in') return void signIn();
  if (item === 'notification-settings') return void host.shell.openExternal(NOTIFICATION_SETTINGS);
  // adding a lead needs somewhere to type one in - for now it does nothing
  if (item === 'lead-add' || item.startsWith('lead:')) return;
  if (!item.startsWith('{')) return;

  const action = JSON.parse(item) as Action;
  switch (action.do) {
    case 'view':
      return void host.shell.openExternal(action.url);
    case 'approve': {
      const found = [...pullRequests, ...deployments].find(each => each.url === action.url);
      if (!found) return;
      return void operation(() => approve(found, action.environment));
    }
    case 'send': {
      const found = [...pullRequests, ...deployments].find(each => each.url === action.url);
      // what goes to the other lead is just what it is and where
      const approval: SentItem | undefined = found && { kind: found.kind, title: found.title, url: found.url };
      const lead = others().find(each => each.user === action.to);
      if (!approval || !lead) return;
      return void operation(async () => {
        await sendTo(folder, lead, me()?.name ?? user, approval).then(
          () => log(`sent ${approval.kind} to ${lead.name}: ${approval.title}`),
          async error => {
            log(`couldn't send to ${lead.name}: ${(error as Error).message}`);
            await render({ tooltip: `Couldn't send to ${lead.name}: ${(error as Error).message}` });
          });
      });
    }
  }
});

// what an approval says it was
const approvalMessage = `Auto approved by ${user} via ${appName}`;

// approves a pull request, or a deployment to one environment, then looks
// again - it should drop off the list
async function approve(approval: Approval, environmentId?: number) {
  const what = `#${approval.number} ${approval.title} (${approval.repo})`;
  try {
    const github = await tokenFor(user);
    if (!github) throw new Error(`gh isn't signed in as ${user}`);
    if (approval.deployment) {
      const environment = approval.deployment.environments.find(each => each.id === environmentId);
      if (!environment) throw new Error('that environment isn\'t waiting any more');
      await approveDeployment(github, approval.deployment, environment, approvalMessage);
      log(`approved deployment to ${environment.name}: ${what}`);
    } else {
      await approvePullRequest(github, approval.url, approvalMessage);
      log(`approved pull request: ${what}`);
    }
  } catch (error) {
    const message = (error as Error).message.split('\n')[0];
    log(`couldn't approve ${what}: ${message}`);
    await render({ tooltip: `Couldn't approve: ${message}` });
    return;
  }
  await refresh();
}

// the leads alone, when the folder says they've changed - one at a time, with
// one more after it if something changed meanwhile
let leadsChecking: Promise<void> | undefined;
let leadsAgain = false;
function refreshLeads() {
  if (leadsChecking) {
    leadsAgain = true;
    return leadsChecking;
  }
  return leadsChecking = (async () => {
    do {
      leadsAgain = false;
      await checkLeads().then(
        () => render(),
        error => {
          log(`couldn't read the leads: ${(error as Error).message.split('\n')[0]}`);
          return render({ tooltip: `Couldn't read the leads: ${(error as Error).message.split('\n')[0]}` });
        },
      );
    } while (leadsAgain);
  })().finally(() => leadsChecking = undefined);
}

// leads.json changing can make this user a lead, or stop it being one; another
// lead's token changing means they've just started (or stopped). This app's
// own token is its own doing.
const ownToken = `.${user}.json`;
let settling: NodeJS.Timeout | undefined;
fs.watch(folder, (_, file) => {
  if (file === ownToken) return;
  if (file && file !== 'leads.json' && !/^\..+\.json$/.test(file)) return;
  clearTimeout(settling);
  settling = setTimeout(() => void refreshLeads(), 300);
});

void operation(refresh);
setInterval(() => void refresh(), CHECK_EVERY_MS);
