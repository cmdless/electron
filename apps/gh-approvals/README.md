# @cmdless/gh-approvals

GitHub approvals, from the tray: the pull requests your review is requested on and the deployments waiting on your approval, from your notification inbox — and everyone else's, straight from their trays.

```
gh-approvals
gh-approvals set user <github login>
gh-approvals set org add <owner> | remove <owner> | clear
gh-approvals set provider none | <provider>...
```

Run with nothing, it's the tray. Its settings are kept in `config.json` for every run after, each set once with `set` — which is refused while the tray runs, since it would be written over:

- `set user` — the GitHub account it runs for. It won't start until it's set. [gh](https://cli.github.com/) has to be signed in as it (the tray offers to log in); until it is, the tray does nothing else.
- `set org` — only what's in these owners' repositories: `add` or `remove` one, or `clear` them all. With none, everything.
- `set provider` — what the trays find each other through: `folder <path>`, `graph-app-folder <tenant id> <client id> [personal | drive <drive id> | site <site id>] [<redirect URI>]` or `dropbox [<app key> [<redirect URI>]]`, configured as every [RTC provider](../../packages/rtc-sdk#provider-settings) is — or `none`, and the tray shows just your own items.

To set it up and start: `gh-approvals set user <login> && gh-approvals set provider folder ~/OneDrive/team && gh-approvals`.

For a team through Microsoft Graph, the App folder is one everyone can reach — a SharePoint site's (`site <site id>`) or a document library's (`drive <drive id>`) — not `personal`, which is each user's own.

## What it checks

The inbox (`notifications?all=true&is_done=false`) says what there is to look at: review requests and deployment approval requests. Each one's own state says whether it's still waiting — a pull request still open and requested of you (or of your team, and not approved by you since), a run still waiting on an environment you can approve. Done items are only looked at again once their notification moves.

Review requests that never reached the inbox — made before you read it this way, or with notifications going elsewhere — come from a search (`is:pr is:open review-requested:@me`, in the `--org` owners if given). The search has a rate limit of its own and may not be free while nothing changes, so it runs only at start and on **Check Now**. What it finds is then looked at every refresh, like anything else waiting, until it isn't.

Every request is conditional on what GitHub answered last, kept in `github-cache.json` in userData, so an unchanged answer (304) costs nothing against the rate limit. It polls as often as the inbox asks (`X-Poll-Interval`, usually a minute). **Check Now** shows what's left of the rate limit this hour and what the last refresh cost: `Check Now (4,980 / 5,000, last 1 (16))` is 4,980 of 5,000 left, and 1 of the last refresh's 16 requests counted.

**Automatically Mark as Done** (off by default) marks a merged pull request's notification done, and a repository's approval requests once nothing there is waiting on you.

## The other trays

While it's signed in and has a provider, a tray is a device on it — an [RTC host](../../packages/rtc-sdk) — and the trays reach each other over WebRTC, not by host name: on one network by their local addresses, across networks through STUN. The provider only carries their advertisements and the offers and answers that connect them; nothing of anyone's items is written there. Anyone who can write where it signals can reach every running tray; that's the trust.

**Approval UI…** in the account menu opens a window on every device the tray knows of: its own, and each tray it's connected to, each with its pull requests and deployments by repository. Each tray's items come over as it changes them, and the window follows them as they do.

**Show Shortcuts…** in the same menu has a script that starts the tray as this one was started — its provider, account and owners set, then the tray — for Windows (`.cmd`), macOS (`.command`) or Linux (`.sh`), and from npm or straight from this repo through [gx](https://github.com/cmdless/gx), which builds it once per commit. Settings are refused while a tray is running, so a script run then just brings up the one that's running.

A provider with an account (Microsoft's, Dropbox's) is signed in to through the [auth broker](../../apps/auth), which keeps the sign-in for every run after. Until it is, **Login to OneDrive...** (or SharePoint, or Dropbox) stands where **Users** would; once it is, **Users** takes its place, and **Logout of OneDrive** is at the end of the account menu.

Each tray serves its user's items as a state channel, and connects to every other running tray — once each time that tray runs — to follow theirs: the whole list when it connects, then each change as it's made. Someone is listed under **Users** only while that connection is open, and with what all their trays have, so the same user on two machines is listed once. A tray that quits hangs up on everyone, and one that's gone quiet is marked offline after three missed heartbeats (three minutes). A tray that couldn't be reached isn't tried again until it runs again. Each machine is its own device, with its own id in `config.json`; your own other machines' trays aren't listed, since they have the same items.

How quickly they find each other is how quickly the folder carries a file between machines — straight away on one machine, a few seconds through most sync clients.

**Check Now** — here or in anyone's tray — asks every connected tray to refresh. Refreshes run one at a time, with one more queued at most.

Each item opens with **View in Browser…**. Your own items have **Auto Approve** under it, with your account. Someone else's have:

- **Request Approval** — a notification in each of their trays; clicking it opens the item.
- **Auto Approve** — one of their trays approves it with *their* account, saying "Auto approved by {them} on behalf of {you}", and tells them it did.

A deployment is approved one environment at a time. A pull request marked `*` was last pushed by whoever it's waiting on, so their approval won't count, and **Auto Approve** is off for it. **Request Refresh** in a user's menu asks just their trays to look again.

## Elsewhere in userData

- `config.json` — this machine's device id, the account and owners, the provider, Automatically Mark as Done, and the last refresh's cost and rate limit.
- `items.json` — your items as of the last refresh, served until the next one.
- `log.txt` — what it did; **Log Viewer…** tails it in a window.
