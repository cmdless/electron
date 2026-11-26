// a pull request someone's review is requested on, or a deployment waiting
// on their approval
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

// a user's items, by url - so a change to one is a change to just that one
export type Items = Record<string, Item>;

export const byUrl = (items: Item[]): Items => Object.fromEntries(items.map(item => [item.url, item]));
