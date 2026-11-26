import type { Answer, GitHub } from './github.js';
import type { DeploymentItem, Environment, Item, PullRequestItem } from './items.js';

// how long to wait between polls when GitHub doesn't say
export const DEFAULT_POLL_SECONDS = 60;

type Notification = {
  id: string;
  reason: string;
  updated_at: string;
  subject: { type: string; url: string | null };
  repository: { full_name: string; owner: { login: string } };
};

type PullRequest = {
  number: number;
  title: string;
  html_url: string;
  state: string;
  merged_at: string | null;
  draft: boolean;
  commits: number;
  user: { login: string };
  head: { sha: string };
  base: { ref: string; repo: { full_name: string } };
  requested_reviewers: { login: string }[];
  requested_teams: unknown[];
};

type Review = { user: { login: string } | null; state: string };
type SearchResult = { items: { pull_request?: { url: string } }[] };
type Commit = { author: { login: string } | null };
type Rule = { type: string; parameters?: { require_last_push_approval?: boolean } };
type Run = { id: number; run_number: number; name: string; display_title: string; html_url: string };
type PendingDeployment = { environment: { id: number; name: string }; current_user_can_approve: boolean };

// What's waiting on a user, from their inbox: the pull requests their review
// is requested on, and the deployments waiting on their approval - and, from a
// search, the pull requests waiting on their review that never made it to the
// inbox (requested before they read their inbox, say, or with notifications
// going elsewhere).
//
// The inbox says what there is to look at; each one's own state says whether
// it's still waiting. What's waiting is looked at again every scan, to see it
// approved, merged or closed. What isn't - done, as far as anyone knows - is
// only looked at again once its notification moves (a new request, a new run
// waiting, a reopen). Every request is conditional, so when nothing has
// changed none of it costs anything, and the inbox says how long to leave it.
export class Inbox {
  // when each notification (by what it's about) last moved, as of the last scan
  private seen = new Map<string, string>();
  // what was waiting as of the last scan: pull requests by their API URL, and
  // the repositories with deployments waiting
  private waitingPulls = new Set<string>();
  private waitingRepos = new Set<string>();
  // whether each pull request needs someone else, by its API URL - kept for
  // as long as its latest commit is the same, so it isn't asked again
  private othersOnly = new Map<string, { sha: string; othersOnly: Promise<boolean> }>();

  constructor(private readonly github: GitHub, private readonly user: string, private readonly orgs: string[]) { }

  // looks at everything in the inbox again on the next scan, done or not -
  // even if a scan already under way would otherwise say what it's seen
  private forgetting = false;
  forget() {
    this.forgetting = true;
  }

  // the pull requests a search found waiting on the user - looked at every
  // scan, like what's waiting in the inbox, until they aren't waiting. The
  // search itself is only run when asked for (it has a rate limit of its
  // own, and may not be free when nothing's changed): on the first scan, and
  // the one after search() - Check Now.
  private searched = new Set<string>();
  private searching = true;
  search() {
    this.searching = true;
  }

  // markDone: notifications whose work is over are marked done, so the inbox
  // doesn't keep them - a pull request once it's merged, and a repository's
  // approval requests once nothing there is waiting on the user. (Those
  // notifications don't say which run they're about, so it's all of a
  // repository's or none.) One that can't be marked is tried again next scan.
  async scan(token: string, markDone = false) {
    const { github, user, orgs } = this;
    const before = this.forgetting ? new Map<string, string>() : this.seen;
    this.forgetting = false;

    // the inbox as GitHub shows it: read or not, but not done
    const { body: notifications, pollInterval } = await github.all<Notification>(token, '/notifications?all=true&is_done=false&per_page=50');
    const wanted = notifications.filter(({ repository }) =>
      orgs.length === 0 || orgs.includes(repository.owner.login.toLowerCase()));

    // when each pull request's notification, and each repository's latest
    // approval request, last moved - and the threads each one has
    const seen = new Map<string, string>();
    const threads = new Map<string, string[]>();
    const note = (key: string, id: string, updatedAt: string) => {
      if (updatedAt > (seen.get(key) ?? '')) seen.set(key, updatedAt);
      threads.set(key, [...threads.get(key) ?? [], id]);
    };
    const repoKey = (repo: string) => `deployments:${repo}`;
    const pullCandidates = new Set<string>();
    const repoCandidates = new Set<string>();
    for (const { id, reason, subject, repository, updated_at } of wanted) {
      if (reason === 'review_requested' && subject.type === 'PullRequest' && subject.url) {
        pullCandidates.add(subject.url);
        note(subject.url, id, updated_at);
      } else if (reason === 'approval_requested') {
        repoCandidates.add(repository.full_name);
        note(repoKey(repository.full_name), id, updated_at);
      }
    }
    // what a search finds waiting, if one's due - a search that fails keeps
    // what the last one found, and is tried again next time
    let searchError: string | undefined;
    let searched = this.searched;
    if (this.searching) {
      this.searching = false;
      try {
        searched = new Set(await searchWaiting(github, token, orgs));
      } catch (error) {
        this.searching = true;
        searchError = (error as Error).message;
      }
    }

    const moved = (key: string) => before.get(key) !== seen.get(key);
    const pullUrls = [...new Set([
      ...[...pullCandidates].filter(url => this.waitingPulls.has(url) || moved(url)),
      ...searched,
    ])];
    const deploymentRepos = [...repoCandidates].filter(repo => this.waitingRepos.has(repo) || moved(repoKey(repo)));

    const rules = new Map<string, Promise<boolean>>();
    const [pulls, deployments] = await Promise.all([
      Promise.all(pullUrls.map(async url => ({ url, pull: await pullRequest(github, token, user, url, rules, this.othersOnly) }))),
      Promise.all(deploymentRepos.map(repo => waitingIn(github, token, repo))),
    ]);
    const open = pulls.filter((each): each is { url: string; pull: PullRequestItem } => typeof each.pull === 'object');

    // what's finished, marked done - what couldn't be is forgotten, so it's
    // looked at again
    let markedDone = 0;
    let markDoneError: string | undefined;
    if (markDone) {
      const finished = [
        ...pulls.filter(({ pull }) => pull === 'merged').map(({ url }) => url),
        ...deploymentRepos.filter((_, index) => deployments[index].length === 0).map(repoKey),
      ];
      await Promise.all(finished.map(async key => {
        const results = await Promise.allSettled((threads.get(key) ?? []).map(id => github.markDone(token, id)));
        markedDone += results.filter(result => result.status === 'fulfilled').length;
        const failed = results.find(result => result.status === 'rejected');
        if (!failed) return;
        seen.delete(key);
        markDoneError ??= (failed.reason as Error).message;
      }));
    }

    // only once everything's been looked at: a scan that fails leaves the
    // next one to look at all of it again
    this.seen = seen;
    this.waitingPulls = new Set(open.map(({ url }) => url));
    this.waitingRepos = new Set(deployments.flat().map(item => item.repo));
    // what the search found stops being looked at once it isn't waiting
    this.searched = new Set([...searched].filter(url => this.waitingPulls.has(url)));
    for (const url of this.othersOnly.keys())
      if (!pullCandidates.has(url) && !this.searched.has(url)) this.othersOnly.delete(url);

    const items: Item[] = [...open.map(({ pull }) => pull), ...deployments.flat()];
    return { items, pollSeconds: pollInterval ?? DEFAULT_POLL_SECONDS, markedDone, markDoneError, searchError };
  }
}

// the open pull requests waiting on the user's review, by API URL - asked of
// the search, in the given owners' repositories if there are any
async function searchWaiting(github: GitHub, token: string, orgs: string[]) {
  const query = ['is:pr', 'is:open', 'draft:false', 'archived:false', 'review-requested:@me', ...orgs.map(org => `org:${org}`)].join(' ');
  const urls: string[] = [];
  let next: string | undefined = `/search/issues?q=${encodeURIComponent(query)}&per_page=100`;
  while (next) {
    const page: Answer<SearchResult> = await github.get<SearchResult>(token, next);
    for (const item of page.body.items) if (item.pull_request) urls.push(item.pull_request.url);
    next = page.next;
  }
  return urls;
}

// a pull request the inbox says the user's review was requested on - if it's
// still open, and still waiting on them: requested of them, or of a team
// they're on and not approved by them since. Otherwise, whether it's merged.
// Whether it needs someone else is only asked again once there's a new commit.
async function pullRequest(
  github: GitHub, token: string, user: string, url: string, rules: Map<string, Promise<boolean>>,
  known: Map<string, { sha: string; othersOnly: Promise<boolean> }>,
): Promise<PullRequestItem | 'merged' | undefined> {
  const { body: pull } = await github.get<PullRequest>(token, url);
  if (pull.merged_at) return 'merged';
  if (pull.state !== 'open' || pull.draft) return undefined;
  const me = user.toLowerCase();
  const requestedOfMe = pull.requested_reviewers.some(({ login }) => login.toLowerCase() === me);
  if (!requestedOfMe) {
    if (pull.requested_teams.length === 0) return undefined;
    const { body: reviews } = await github.all<Review>(token, `${url}/reviews?per_page=100`);
    const mine = reviews.filter(review => review.user?.login.toLowerCase() === me);
    if (mine.at(-1)?.state === 'APPROVED') return undefined;
  }

  let othersOnly = known.get(url)?.sha === pull.head.sha ? known.get(url)!.othersOnly : undefined;
  if (!othersOnly) {
    othersOnly = pushedLastBy(github, token, me, pull, url, rules);
    known.set(url, { sha: pull.head.sha, othersOnly });
    othersOnly.catch(() => known.delete(url));
  }

  return {
    kind: 'pull-request', repo: pull.base.repo.full_name, number: pull.number, title: pull.title,
    url: pull.html_url, author: pull.user.login, othersOnly: await othersOnly,
  };
}

// whether a pull request's latest push is the user's, on a branch whose rules
// won't count the last pusher's approval. GitHub doesn't say who pushed, so
// the latest commit's author stands in. `rules` keeps each branch's answer
// for the rest of a scan.
async function pushedLastBy(
  github: GitHub, token: string, me: string, pull: PullRequest, url: string, rules: Map<string, Promise<boolean>>,
) {
  const lastPage = Math.max(1, Math.ceil(pull.commits / 100));
  const { body: commits } = await github.get<Commit[]>(token, `${url}/commits?per_page=100&page=${lastPage}`);
  if (commits.at(-1)?.author?.login.toLowerCase() !== me) return false;

  const repo = pull.base.repo.full_name;
  const branch = `${repo}#${pull.base.ref}`;
  if (!rules.has(branch)) {
    rules.set(branch, github.get<Rule[]>(token, `/repos/${repo}/rules/branches/${encodeURIComponent(pull.base.ref)}`).then(
      ({ body }) => body.some(rule => rule.type === 'pull_request' && rule.parameters?.require_last_push_approval === true),
      () => false,
    ));
  }
  return rules.get(branch)!;
}

// the runs in a repository waiting on a deployment approval the user can
// give - which also says they're still waiting, whatever the inbox says
async function waitingIn(github: GitHub, token: string, repo: string): Promise<DeploymentItem[]> {
  const { body } = await github.get<{ workflow_runs: Run[] }>(token, `/repos/${repo}/actions/runs?status=waiting&per_page=100`);
  const runs = await Promise.all(body.workflow_runs.map(async (run): Promise<DeploymentItem> => {
    const { body: pending } = await github.get<PendingDeployment[]>(token, `/repos/${repo}/actions/runs/${run.id}/pending_deployments`);
    const environments: Environment[] = pending
      .filter(each => each.current_user_can_approve)
      .map(({ environment }) => ({ id: environment.id, name: environment.name }));
    return {
      kind: 'deployment', repo, number: run.run_number, runId: run.id,
      title: `${run.name}: ${run.display_title}`, url: run.html_url, environments,
    };
  }));
  return runs.filter(run => run.environments.length > 0);
}
