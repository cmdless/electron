# @cmdless/peerlink

The peerlink daemon: it advertises what this device offers to the other devices signed in to the same Dropbox account (through the same Dropbox app), keeps up with what they offer, and answers their connections over WebRTC. Programs offer themselves through `@cmdless/peerlink-sdk`'s `offer()`, which starts the daemon if it isn't running.

## Commands

| Command | |
|---|---|
| `peerlink start [--tray \| --no-tray]` | Starts the daemon if it isn't running. `--tray` and `--no-tray` also set whether it shows a tray. |
| `peerlink stop` | Marks this device offline and ends the daemon. |
| `peerlink status` | Prints the daemon's state as JSON (addresses left out), or `{ "running": false }` with exit code 1. |
| `peerlink sign-in` / `sign-out` | Signs in to or out of Dropbox. |
| `peerlink set <setting> <value>` | Changes `name`, `heartbeat` (seconds, at least 15) or `tray` (`true` or `false`). |

Only `start` starts the daemon. The rest work on whatever's running, and `sign-in`, `sign-out` and `set` work without it too: the sign-in is the auth broker's, which a daemon started later picks up, and a setting goes into `settings.json` for the next start.

## The tray

Whether the daemon shows a tray is the `tray` setting, so it's the same however the daemon was started — by `peerlink start`, or by a program offering itself. Changing it on a running daemon shows or takes away the tray at once. The tray is on a throwaway UI host of its own, so it never meets another app's, and its menu shows only what's in the daemon's state: the account, the other devices and what each offers, and what this device offers. The host state's `tray` says whether it's `off`, `starting`, `shown` or in `error` (with `trayError`) — no display, say, which leaves the daemon running without one.

## State

`~/.cmdless/apps/peerlink/settings.json` holds the device's id and name, its ICE servers, its heartbeat and the tray setting. The daemon reads it once and writes it whole on every change, so while it runs, settings change through it (as `peerlink set` does).
