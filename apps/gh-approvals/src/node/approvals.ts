import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

// gh, as the account the token is for - handing gh its token for this one
// command, so gh's active account stays whatever it was
const gh = (token: string, args: string[]) =>
  run('gh', args, { env: { ...process.env, GH_TOKEN: token, GH_HOST: 'github.com' }, maxBuffer: 16 * 1024 * 1024 })
    .then(({ stdout }) => stdout);

// one JSON value per line, as gh's --jq prints them with @json
const lines = <T>(stdout: string) => stdout.split('\n').filter(Boolean).map(line => JSON.parse(line) as T);

// a pull request waiting on your review
export type ReviewRequest = {
  number: number;
  title: string;
  url: string;
  repository: { nameWithOwner: string };
};

// how many pull requests a search brings back - gh's own default is 30
const SEARCH_LIMIT = '100';

// the open pull requests an account's review has been requested on - from
// them, or from a team they're on
export async function reviewRequests(token: string): Promise<ReviewRequest[]> {
  return JSON.parse(await gh(token, [
    'search', 'prs', '--review-requested=@me', '--state=open', '--limit', SEARCH_LIMIT,
    '--json', 'number,title,url,repository',
  ])) as ReviewRequest[];
}

// this account's own open pull requests that aren't approved yet - someone
// else has to approve them. Not drafts.
export async function ownPullRequests(token: string): Promise<ReviewRequest[]> {
  return JSON.parse(await gh(token, [
    'search', 'prs', '--author=@me', '--state=open', '--draft=false', '--limit', SEARCH_LIMIT,
    '--json', 'number,title,url,repository', '--', '-review:approved',
  ])) as ReviewRequest[];
}

// whether a pull request's latest push is this user's, on a branch whose rules
// won't count the last pusher's approval - so someone else has to approve it.
// GitHub doesn't say who pushed, so the latest commit's author stands in.
// `rules` keeps each branch's answer for the rest of a check.
export async function pushedLastBy(token: string, user: string, url: string, rules: Map<string, Promise<boolean>>) {
  const { baseRefName, commits } = JSON.parse(await gh(token, ['pr', 'view', url, '--json', 'baseRefName,commits'])) as {
    baseRefName: string;
    commits: { authors: { login: string }[] }[];
  };
  const latest = commits.at(-1)?.authors.map(author => author.login.toLowerCase()) ?? [];
  if (!latest.includes(user.toLowerCase())) return false;

  const repo = new URL(url).pathname.split('/').slice(1, 3).join('/');
  const branch = `${repo}#${baseRefName}`;
  if (!rules.has(branch)) {
    rules.set(branch, gh(token, [
      'api', `repos/${repo}/rules/branches/${encodeURIComponent(baseRefName)}`,
      '--jq', '[.[] | select(.type == "pull_request") | .parameters.require_last_push_approval] | any',
    ]).then(answer => answer.trim() === 'true', () => false));
  }
  return rules.get(branch)!;
}

// approves a pull request, as Add review > Approve > Submit does on GitHub
export async function approvePullRequest(token: string, url: string, body: string) {
  await gh(token, ['pr', 'review', url, '--approve', '--body', body]);
}

// an environment a deployment is waiting on, for this account to approve
export type Environment = { id: number; name: string };

// a workflow run waiting on this account to approve some of its deployments
export type PendingDeployment = {
  repo: string;
  runId: number;
  runNumber: number;
  title: string;
  url: string;
  environments: Environment[];
};

// the repositories the inbox says have a deployment waiting on this
// account's approval - read or not, until it's marked done
async function approvalRepos(token: string) {
  const repos = lines<string>(await gh(token, [
    'api', '--paginate', 'notifications?all=true&per_page=50',
    '--jq', '.[] | select(.reason == "approval_requested") | .repository.full_name | @json',
  ]));
  return [...new Set(repos)];
}

// the runs in a repository waiting on a deployment approval, with the
// environments this account can approve - which also says they're still
// waiting, whatever the inbox says
async function waitingIn(token: string, repo: string): Promise<PendingDeployment[]> {
  const runs = lines<[number, number, string, string, string]>(await gh(token, [
    'api', `repos/${repo}/actions/runs?status=waiting&per_page=100`,
    '--jq', '.workflow_runs[] | [.id, .run_number, .name, .display_title, .html_url] | @json',
  ]));
  const pending = await Promise.all(runs.map(async ([runId, runNumber, workflow, title, url]) => {
    const environments = lines<[number, string]>(await gh(token, [
      'api', `repos/${repo}/actions/runs/${runId}/pending_deployments`,
      '--jq', '.[] | select(.current_user_can_approve) | [.environment.id, .environment.name] | @json',
    ])).map(([id, name]) => ({ id, name }));
    return { repo, runId, runNumber, title: `${workflow}: ${title}`, url, environments };
  }));
  return pending.filter(each => each.environments.length > 0);
}

// every deployment waiting on this account, from the repositories its inbox
// points at
export async function pendingDeployments(token: string): Promise<PendingDeployment[]> {
  const repos = await approvalRepos(token);
  return (await Promise.all(repos.map(repo => waitingIn(token, repo)))).flat();
}

// approves a run's deployment to one environment, as Review deployments >
// Approve and deploy does on GitHub
export async function approveDeployment(token: string, deployment: PendingDeployment, environment: Environment, comment: string) {
  await gh(token, [
    'api', '-X', 'POST', `repos/${deployment.repo}/actions/runs/${deployment.runId}/pending_deployments`,
    '-F', `environment_ids[]=${environment.id}`, '-f', 'state=approved', '-f', `comment=${comment}`,
  ]);
}
