# @cmdless/gh-approvals

GitHub approvals, from the tray: the pull requests your review is requested on and the deployments waiting on your approval, from your notification inbox — and everyone else's, straight from their trays.

```
gh-approvals --user <github login> [--share <folder>] [--org <owner>]...
```

- `--user` — the GitHub account it runs for. [gh](https://cli.github.com/) has to be signed in as it (the tray offers to log in); until it is, the tray does nothing else.
- `--share` — the folder the trays find each other through. It's kept in `config.json`, so it's only needed to change it; `--share ""` stops sharing. Without one, the tray shows just your own items. It can't be changed while the tray runs.
- `--org` — only what's in this owner's repositories. Repeat it for more.

## What it checks

The inbox (`notifications?all=true&is_done=false`) says what there is to look at: review requests and deployment approval requests. Each one's own state says whether it's still waiting — a pull request still open and requested of you (or of your team, and not approved by you since), a run still waiting on an environment you can approve. Done items are only looked at again once their notification moves.

Review requests that never reached the inbox — made before you read it this way, or with notifications going elsewhere — come from a search (`is:pr is:open review-requested:@me`, in the `--org` owners if given). The search has a rate limit of its own and may not be free while nothing changes, so it runs only at start and on **Check Now**. What it finds is then looked at every refresh, like anything else waiting, until it isn't.

Every request is conditional on what GitHub answered last, kept in `github-cache.json` in userData, so an unchanged answer (304) costs nothing against the rate limit. It polls as often as the inbox asks (`X-Poll-Interval`, usually a minute). **Check Now** shows what's left of the rate limit this hour and what the last refresh cost: `Check Now (4,980 / 5,000, last 1 (16))` is 4,980 of 5,000 left, and 1 of the last refresh's 16 requests counted.

**Automatically Mark as Done** (off by default) marks a merged pull request's notification done, and a repository's approval requests once nothing there is waiting on you.

## The other trays

While it's signed in and has a share, a tray is a device on it — an [RTC host](../../packages/rtc-sdk), signaling through the folder — and the trays reach each other over WebRTC, not by host name: on one network by their local addresses, across networks through STUN. The folder only carries their advertisements and the offers and answers that connect them; nothing of anyone's items is written there. It can be any folder every tray can write, kept in step between machines by a sync client (OneDrive, Dropbox, ...) or local to one. Anyone who can write it can reach every running tray; the share is the trust.

Each tray serves its user's items as a state channel, and connects to every other running tray — once each time that tray runs — to follow theirs: the whole list when it connects, then each change as it's made. Someone is listed under **Users** only while that connection is open, and with what all their trays have, so the same user on two machines is listed once. A tray that quits hangs up on everyone, and one that's gone quiet is marked offline after three missed heartbeats (three minutes). A tray that couldn't be reached isn't tried again until it runs again. Each machine is its own device, with its own id in `config.json`; your own other machines' trays aren't listed, since they have the same items.

How quickly they find each other is how quickly the folder carries a file between machines — straight away on one machine, a few seconds through most sync clients.

**Check Now** — here or in anyone's tray — asks every connected tray to refresh. Refreshes run one at a time, with one more queued at most.

Each item opens with **View in Browser…**. Your own items have **Auto Approve** under it, with your account. Someone else's have:

- **Request Approval** — a notification in each of their trays; clicking it opens the item.
- **Auto Approve** — one of their trays approves it with *their* account, saying "Auto approved by {them} on behalf of {you}", and tells them it did.

A deployment is approved one environment at a time. A pull request marked `*` was last pushed by whoever it's waiting on, so their approval won't count, and **Auto Approve** is off for it. **Request Refresh** in a user's menu asks just their trays to look again.

## Elsewhere in userData

- `config.json` — this machine's device id, the share, Automatically Mark as Done, and the last refresh's cost and rate limit.
- `items.json` — your items as of the last refresh, served until the next one.
- `log.txt` — what it did; **Log Viewer…** tails it in a window.
