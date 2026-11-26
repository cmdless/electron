# @cmdless/peerlink

The peerlink daemon: one [RTC host](../../packages/rtc-sdk) per device, with a registry of offers on top. It advertises what this device offers to the other devices on the same provider, keeps up with what they offer, and relays each channel they open to the offer it names (`{ offerId }` as the channel's label), on to that offer's local WebSocket. Programs offer themselves through `@cmdless/peerlink-sdk`'s `offer()`, which starts the daemon if it isn't running.

## Commands

| Command | |
|---|---|
| `peerlink start [--tray \| --no-tray]` | Starts the daemon if it isn't running. `--tray` and `--no-tray` also set whether it shows a tray (it does unless told otherwise). |
| `peerlink stop` | Marks this device offline and ends the daemon. |
| `peerlink status` | Prints the daemon's state as JSON (addresses left out), or `{ "running": false }` with exit code 1. |
| `peerlink sign-in` / `sign-out` | Signs in to or out of the provider's account — Dropbox's or OneDrive's; a folder has none. |
| `peerlink set <setting> <value>` | Changes `name`, `heartbeat` (seconds, at least 15) or `tray` (`true` or `false`). |
| `peerlink set provider dropbox [<app key> [<redirect URI>]]` | Syncs through Dropbox: peerlink's own app, or yours by its app key and one of its registered redirect URIs. |
| `peerlink set provider folder <path>` | Syncs through a folder (a relative path is taken from where you are). |
| `peerlink set provider onedrive <tenant id> <client id> [<drive> [<redirect URI>]]` | Syncs through the App folder on a OneDrive drive, by an Entra app of yours. |

Only `start` starts the daemon. The rest work on whatever's running, and `sign-in`, `sign-out` and `set` work without it too: the sign-in is the auth broker's, which a daemon started later picks up, and a setting goes into `settings.json` for the next start.

## Providers

The provider is what carries each device's advertisement and the WebRTC offers and answers between devices; the daemon uses one at a time, the `provider` setting's. Devices see each other when they're on the same one. Changing it on a running daemon marks this device offline on the old one and moves to the new one.

- **Dropbox** (the default) — everything goes in the Dropbox app's own App folder, so it's devices signed in to the same Dropbox *account* through the same *app*. Without an app key it's peerlink's own app. An app of your own needs App folder access, and is given with one of its registered redirect URIs — any of them: nothing has to answer there, since the sign-in window catches the redirect before it's requested. Left out, it's `http://localhost/cmdless-auth`. Dropbox has no way to look an app's redirect URIs up, so it has to be given. Each app key is its own sign-in.
- **OneDrive** — the App folder on a OneDrive or SharePoint drive, through an Entra app of yours (its tenant and client id; Mobile and desktop platform, redirect `http://localhost` unless given another; `Files.ReadWrite.AppFolder` only). The drive is a Graph path: `/me/drive` (the default) for your own devices, or `/drives/{driveId}` or `/sites/{siteId}/drive` for one others share. Each watched folder is listed every few seconds, so devices take a few seconds to connect. See [rtc-sdk](../../packages/rtc-sdk#providers).
- **Folder** — a folder every device can write to, such as one OneDrive, Dropbox or another sync client keeps in step across machines. There's no account: whoever can write the folder is in the group. Changes are noticed through the OS's file events, so a network share that doesn't send them won't work, and a sync client adds its own delay — a few seconds, which signaling doesn't mind.

The providers, and their settings, are [`@cmdless/rtc-sdk`](../../packages/rtc-sdk)'s — the same settings any other app takes; what the daemon advertises is its offers, in its advertisement's `info`.

## The tray

Whether the daemon shows a tray is the `tray` setting — on unless it's been set to `false`, in a new `settings.json` or one from before the setting existed — so it's the same however the daemon was started — by `peerlink start`, or by a program offering itself. Changing it on a running daemon shows or takes away the tray at once. The tray is on a throwaway UI host of its own, so it never meets another app's, and its menu shows only what's in the daemon's state: the device and its provider (with signing in and out, for one with an account) under **Account**, and — once signed in — the other devices and what each offers, and what this device offers. The host state's `tray` says whether it's `off`, `starting`, `shown` or in `error` (with `trayError`) — no display, say, which leaves the daemon running without one.

## State

`~/.cmdless/apps/peerlink/settings.json` holds the device's id and name, its ICE servers, its heartbeat, the tray setting and the provider. The daemon reads it once and writes it whole on every change, so while it runs, settings change through it (as `peerlink set` does).
