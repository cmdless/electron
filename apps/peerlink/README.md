# @cmdless/peerlink

The peerlink daemon: it advertises what this device offers to the other devices on the same provider, keeps up with what they offer, and answers their connections over WebRTC. Programs offer themselves through `@cmdless/peerlink-sdk`'s `offer()`, which starts the daemon if it isn't running.

## Commands

| Command | |
|---|---|
| `peerlink start [--tray \| --no-tray]` | Starts the daemon if it isn't running. `--tray` and `--no-tray` also set whether it shows a tray (it does unless told otherwise). |
| `peerlink stop` | Marks this device offline and ends the daemon. |
| `peerlink status` | Prints the daemon's state as JSON (addresses left out), or `{ "running": false }` with exit code 1. |
| `peerlink sign-in` / `sign-out` | Signs in to or out of the provider's account — Dropbox's; a folder has none. |
| `peerlink set <setting> <value>` | Changes `name`, `heartbeat` (seconds, at least 15) or `tray` (`true` or `false`). |
| `peerlink set provider dropbox [app key]` | Syncs through Dropbox: peerlink's own app, or yours by its app key. |
| `peerlink set provider folder <path>` | Syncs through a folder (a relative path is taken from where you are). |

Only `start` starts the daemon. The rest work on whatever's running, and `sign-in`, `sign-out` and `set` work without it too: the sign-in is the auth broker's, which a daemon started later picks up, and a setting goes into `settings.json` for the next start.

## Providers

The provider is what carries each device's advertisement and the WebRTC offers and answers between devices; the daemon uses one at a time, the `provider` setting's. Devices see each other when they're on the same one. Changing it on a running daemon marks this device offline on the old one and moves to the new one.

- **Dropbox** (the default) — everything goes in the Dropbox app's own App folder, so it's devices signed in to the same Dropbox *account* through the same *app*. Without an app key it's peerlink's own app. An app of your own needs `http://localhost/cmdless-auth` as a redirect URI (where the auth broker takes the sign-in back) and App folder access; each app key is its own sign-in.
- **Folder** — a folder every device can write to, such as one OneDrive, Dropbox or another sync client keeps in step across machines. There's no account: whoever can write the folder is in the group. Changes are noticed through the OS's file events, so a network share that doesn't send them won't work, and a sync client adds its own delay — a few seconds, which signaling doesn't mind.

Both lay it out the same way: `devices/<deviceId>.json` for each advertisement, and `signal/<deviceId>/<sessionId>.offer.json` with its `.answer.json` beside it for each connection, removed once it's up. Providers are `SignalingProvider`s in `@cmdless/peerlink-sdk` — the interface is presence and offers and answers, not files, so a provider can carry them however it likes.

## The tray

Whether the daemon shows a tray is the `tray` setting — on unless it's been set to `false`, in a new `settings.json` or one from before the setting existed — so it's the same however the daemon was started — by `peerlink start`, or by a program offering itself. Changing it on a running daemon shows or takes away the tray at once. The tray is on a throwaway UI host of its own, so it never meets another app's, and its menu shows only what's in the daemon's state: the device and its provider (with signing in and out, for Dropbox) under **Account**, and — once signed in — the other devices and what each offers, and what this device offers. The host state's `tray` says whether it's `off`, `starting`, `shown` or in `error` (with `trayError`) — no display, say, which leaves the daemon running without one.

## State

`~/.cmdless/apps/peerlink/settings.json` holds the device's id and name, its ICE servers, its heartbeat, the tray setting and the provider. The daemon reads it once and writes it whole on every change, so while it runs, settings change through it (as `peerlink set` does).
