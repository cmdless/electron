# @cmdless/gh-approvals

GitHub approvals, from the tray: the pull requests your review is requested on and the deployments waiting on your approval, from your notification inbox — and everyone else's, from a folder you share.

```
gh-approvals --user <github login> [--data <folder>] [--org <owner>]...
```

- `--user` — the GitHub account it runs for. [gh](https://cli.github.com/) has to be signed in as it (the tray offers to log in); until it is, the tray does nothing else.
- `--data` — the folder every user's tray shares. Defaults to `data` in the app's own userData.
- `--org` — only what's in this owner's repositories. Repeat it for more.

## What it checks

The inbox (`notifications?all=true&is_done=false`) says what there is to look at: review requests and deployment approval requests. Each one's own state says whether it's still waiting — a pull request still open and requested of you (or of your team, and not approved by you since), a run still waiting on an environment you can approve. Done items are only looked at again once their notification moves.

Review requests that never reached the inbox — made before you read it this way, or with notifications going elsewhere — come from a search (`is:pr is:open review-requested:@me`, in the `--org` owners if given). The search has a rate limit of its own and may not be free while nothing changes, so it runs only at start and on **Check now**. What it finds is then looked at every refresh, like anything else waiting, until it isn't.

Every request is conditional on what GitHub answered last, kept in `github-cache.json` in userData, so an unchanged answer (304) costs nothing against the rate limit. It polls as often as the inbox asks (`X-Poll-Interval`, usually a minute); **Logged in as … › Quota** shows what the last refresh cost and what's left this hour.

**Automatically Mark as Done** (off by default) marks a merged pull request's notification done, and a repository's approval requests once nothing there is waiting on you.

## The shared folder

```
{data}/{user}/user.json                                   while that user's tray runs
{data}/{user}/pull_requests/{owner}/{repo}/{number}.json
{data}/{user}/deployments/{owner}/{repo}/{runId}.json
```

Each tray writes only its own user's folder, and reads everyone else's to list them under **Users**. `user.json` holds a token, where the tray listens (`host`, `port`), and when its files last changed — so the others only re-read a folder when it has. Anyone who can read the folder can reach every running tray; the folder is the trust.

A tray listens on a free port while it's signed in. **Check now** — here or in anyone's tray — asks every running tray to refresh, and a tray whose files changed asks again, so everyone sees it. Refreshes run one at a time, with one more queued at most. From **Users** you can ask a tray to refresh, approve its user's items with your own account, or **Send To** someone a pull request only they can approve.

## Elsewhere in userData

- `config.json` — Automatically Mark as Done, and the last refresh's cost and rate limit.
- `log.txt` — what it did; **Log Viewer…** tails it in a window.
