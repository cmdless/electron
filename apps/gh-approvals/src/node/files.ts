import fs from 'node:fs/promises';
import path from 'node:path';

// Each user's folder in the data folder, written only by that user's tray
// and read by everyone's:
//
//   {user}/user.json                                 their tray, while it runs
//   {user}/pull_requests/{owner}/{repo}/{number}.json
//   {user}/deployments/{owner}/{repo}/{runId}.json
//
// Every file is written whole, under a name of its own and then renamed into
// place, so nobody ever reads half of one.

// a pull request someone's review is requested on, or a deployment waiting
// on their approval - as it's written to their folder
export type PullRequestItem = {
  kind: 'pull-request';
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  // they pushed to it last, on a branch whose rules won't count the last
  // pusher's approval - someone else has to approve it
  othersOnly: boolean;
};

export type Environment = { id: number; name: string };

export type DeploymentItem = {
  kind: 'deployment';
  repo: string;
  // the run's number, as GitHub shows it
  number: number;
  runId: number;
  title: string;
  url: string;
  // the environments waiting on their approval
  environments: Environment[];
};

export type Item = PullRequestItem | DeploymentItem;

// a tray that's running: the token that gets a request to it through, where
// it listens, and when it last changed its files
export type UserFile = {
  token: string;
  endpoint: { host: string; port: number };
  lastUpdatedAt: string;
};

const KIND_FOLDERS = { 'pull-request': 'pull_requests', deployment: 'deployments' } as const;

// each write's own temporary name, so two writes of one file never share one
let writes = 0;

export async function writeAtomic(file: string, text: string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${++writes}.tmp`;
  await fs.writeFile(temporary, text);
  await fs.rename(temporary, file);
}

// where an item goes in its user's folder, from the user's folder
const itemPath = (item: Item) => path.join(
  KIND_FOLDERS[item.kind], ...item.repo.split('/'), `${item.kind === 'deployment' ? item.runId : item.number}.json`,
);

// every item file in a user's folder, by where it is in it
async function readItemFiles(userFolder: string) {
  const files = new Map<string, string>();
  for (const kind of Object.values(KIND_FOLDERS)) {
    const entries = await fs.readdir(path.join(userFolder, kind), { recursive: true }).catch(() => [] as string[]);
    await Promise.all(entries.filter(entry => entry.endsWith('.json')).map(async entry => {
      const relative = path.join(kind, entry);
      const text = await fs.readFile(path.join(userFolder, relative), 'utf8').catch(() => undefined);
      if (text !== undefined) files.set(relative, text);
    }));
  }
  return files;
}

// the items in some item files - anything unreadable left out
function parseItems(files: Map<string, string>): Item[] {
  const items: Item[] = [];
  for (const text of files.values()) {
    try {
      const item = JSON.parse(text) as Item;
      if (item.kind === 'pull-request' || item.kind === 'deployment') items.push(item);
    } catch { /* being replaced, or not one of ours */ }
  }
  return items;
}

// a user's items, as their folder has them
export async function readItems(folder: string, user: string) {
  return parseItems(await readItemFiles(path.join(folder, user)));
}

// this user's own items: written to their folder as they change, and taken
// away (with folders left empty) as they go
export class OwnItems {
  private written = new Map<string, string>();
  private readonly userFolder: string;

  constructor(folder: string, user: string) {
    this.userFolder = path.join(folder, user);
  }

  // what's there from before, so only what's changed since gets written -
  // and the items it holds
  async load() {
    this.written = await readItemFiles(this.userFolder);
    return parseItems(this.written);
  }

  // brings the folder in line with these items; whether anything changed
  async write(items: Item[]) {
    const wanted = new Map(items.map(item => [itemPath(item), `${JSON.stringify(item, null, 2)}\n`]));
    let changed = false;
    for (const [relative, text] of wanted) {
      if (this.written.get(relative) === text) continue;
      await writeAtomic(path.join(this.userFolder, relative), text);
      this.written.set(relative, text);
      changed = true;
    }
    for (const relative of [...this.written.keys()]) {
      if (wanted.has(relative)) continue;
      await fs.rm(path.join(this.userFolder, relative), { force: true });
      this.written.delete(relative);
      await this.prune(path.dirname(relative));
      changed = true;
    }
    return changed;
  }

  // takes away folders left empty, up to (not including) the kind's own
  private async prune(relative: string) {
    while (relative.includes(path.sep)) {
      const removed = await fs.rmdir(path.join(this.userFolder, relative)).then(() => true, () => false);
      if (!removed) return;
      relative = path.dirname(relative);
    }
  }
}

const userFile = (folder: string, user: string) => path.join(folder, user, 'user.json');

export function writeUserFile(folder: string, user: string, file: UserFile) {
  return writeAtomic(userFile(folder, user), `${JSON.stringify(file, null, 2)}\n`);
}

export function removeUserFile(folder: string, user: string) {
  return fs.rm(userFile(folder, user), { force: true });
}

// a user's tray, if it's running - or nothing, if user.json isn't there (or
// isn't one)
export async function readUserFile(folder: string, user: string): Promise<UserFile | undefined> {
  try {
    const file = JSON.parse(await fs.readFile(userFile(folder, user), 'utf8')) as Partial<UserFile>;
    const { token, endpoint, lastUpdatedAt } = file;
    if (typeof token !== 'string' || typeof lastUpdatedAt !== 'string') return undefined;
    if (typeof endpoint?.host !== 'string' || typeof endpoint.port !== 'number') return undefined;
    return { token, endpoint, lastUpdatedAt };
  } catch {
    return undefined;
  }
}

// the users with a folder in the data folder
export async function listUsers(folder: string) {
  const entries = await fs.readdir(folder, { withFileTypes: true });
  return entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).map(entry => entry.name);
}
