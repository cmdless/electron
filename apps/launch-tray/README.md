# @cmdless/launch-tray

The tray that keeps and runs launches — what `.cmdless` files hold. One runs per user, serving `launchProtocol` on its socket; [`LaunchHost`](../../packages/ui-sdk) connects to it, starting it if it isn't up, and [ui-runtime's launcher](../ui-runtime#the-launcher) uses that for every `.cmdless` file opened or added.

```
launch-tray
```

It takes no arguments: started while one's already running, it finds the socket taken and exits.

- **add** — keeps a launch. The same launch kept already (the same name, running the same commands) is `unchanged`; anything else is shown first, with exactly what it runs, and kept only on **Add** (or **Replace**, for a name that's kept already).
- **open** — runs a launch. The same launch kept already runs at once; anything else is asked about — **Open “…”?**, with what it runs — and kept, then run, so it runs without asking next time.

Asked with `confirm: false` — by code already running as you, which could keep a launch itself anyway — either keeps it without asking, and says so in a notification. A launch from a file (a double-click, or `ui launch`) is always asked about.

Trust goes by what a launch runs, not where it came from: a launch whose commands changed is asked about again. **Launch ›** in the tray lists the kept launches; choosing one runs it. **Update available** shows when npm has a newer version — nothing is ever updated by itself.

Its socket comes up before its tray: a client connects at once, and what it asks waits for the tray's host to start.

## Launches

JSON: a name, and the commands that launch it, run in order.

```json
{
  "name": "gh-approvals",
  "commands": [
    { "command": "npx", "args": ["-y", "@cmdless/gh-approvals@latest"] }
  ]
}
```

Each command runs detached, in the home folder, so whatever it starts outlives the tray; the first that fails (or can't start) ends the launch, and the tray says so with a notification.

## In userData

- `launches/` — the kept launches, one `.cmdless` file each, named after the launch. Changing the folder by hand changes the menu.
- `logs/<launch>.log` — each launch's runs: its commands and everything they printed.
- `launch-tray.log` — what the tray did.
