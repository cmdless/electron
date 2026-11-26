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

Review requests that never reached the inbox — made before you read it this way, or with notifications going elsewhere — come from a search (`is:pr is:open review-requested:@me`, in the `--org` owners if given). The search has a rate limit of its own and may not be free while nothing changes, so it runs only at start and on **Check Now**. What it finds is then looked at every refresh, like anything else waiting, until it isn't.

Every request is conditional on what GitHub answered last, kept in `github-cache.json` in userData, so an unchanged answer (304) costs nothing against the rate limit. It polls as often as the inbox asks (`X-Poll-Interval`, usually a minute). **Check Now** shows what's left of the rate limit this hour and what the last refresh cost: `Check Now (4,980 / 5,000, last 1 (16))` is 4,980 of 5,000 left, and 1 of the last refresh's 16 requests counted.

**Automatically Mark as Done** (off by default) marks a merged pull request's notification done, and a repository's approval requests once nothing there is waiting on you.

## The shared folder

```
{data}/{user}/pull_requests/{owner}/{repo}/{number}.json
{data}/{user}/deployments/{owner}/{repo}/{runId}.json
{data}/.rtc/                                              the trays finding and reaching each other
```

Each tray writes only its own user's folder, and reads everyone else's. Anyone who can write the folder can reach every running tray; the folder is the trust.

While it's signed in, a tray is a device on the folder — an [RTC host](../../packages/rtc-sdk) named after its user, signaling through `.rtc` — and the trays reach each other over WebRTC, not by host name: on one network by their local addresses, across networks through STUN. Each says when its files last changed, so the others re-read a folder only when it has, and keeps a connection open to every other running tray, made once each time that tray runs. Someone is listed under **Users** only while that connection is open: a tray that quits hangs up on everyone, and one that's gone quiet is marked offline after three missed heartbeats (three minutes). A tray that couldn't be reached isn't tried again until it runs again.

How quickly they find each other is how quickly the folder carries a file between machines — straight away on one machine, a few seconds through most sync clients.

**Check Now** — here or in anyone's tray — asks every connected tray to refresh. Refreshes run one at a time, with one more queued at most.

Each item opens with **View in Browser…**. Your own items have **Auto Approve** under it, with your account. Someone else's have:

- **Request Approval** — a notification in their tray; clicking it opens the item.
- **Auto Approve** — their tray approves it with *their* account, saying "Auto approved by {them} on behalf of {you}", and tells them it did.

A deployment is approved one environment at a time. A pull request marked `*` was last pushed by whoever it's waiting on, so their approval won't count, and **Auto Approve** is off for it. **Request Refresh** in a user's menu asks just their tray to look again.

## Elsewhere in userData

- `config.json` — Automatically Mark as Done, and the last refresh's cost and rate limit.
- `log.txt` — what it did; **Log Viewer…** tails it in a window.
