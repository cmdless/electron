# @cmdless/launch-tray

The tray that keeps and runs launches — what `.cmdless` files hold. One runs per user, serving `launchProtocol` on its socket; [`LaunchHost`](../../packages/ui-sdk) connects to it, starting it if it isn't up, and [ui-runtime's launcher](../ui-runtime#the-launcher) uses that for every `.cmdless` file opened or added.

```
launch-tray
```

It takes no arguments: started while one's already running, it finds the socket taken and exits. Its socket comes up before its tray: a client connects at once, and what it asks waits for the tray's host to start.

## Launches

A name, the sources it runs, and the commands that launch it — each one of a source's bins, with arguments, run in order:

```json
{
  "name": "gh-approvals",
  "sources": {
    "npm": { "type": "npm", "package": "@cmdless/gh-approvals" },
    "github": { "type": "git", "repo": "github:cmdless/electron", "workspace": "@cmdless/gh-approvals", "build": ["build"] }
  },
  "commands": {
    "npm": [{ "source": "npm", "args": [] }],
    "GitHub": [{ "source": "github", "args": [] }]
  }
}
```

- **Sources** are packages: `npm` (a `package`, and a `version` — the latest if left out), `git` (a `repo` as npm writes one, a `ref`, the `workspace` in it, and the root scripts to `build` it — run through [gx](https://github.com/cmdless/gx), once per commit), or `local` (a package folder's `path`).
- **Commands** run a source's bin: its only one, or the one named after it, unless `bin` names another. `commands` is a list, or named lists to choose from — prod and dev, say — which the tray's menu shows as a submenu, and opening one without naming which asks.
- Every command's `source` is one of the launch's `sources`, and every source is used.

Each command runs detached, in the home folder, so whatever it starts outlives the tray; the first that fails (or can't start) ends the launch, and the tray says so with a notification.

## Trust

Trust goes to sources, not launches: running a launch that uses a source not trusted yet asks once — **Trust and Run** — naming every new one it uses. After that any launch can run that source's bins with any arguments, without asking. An npm package is trusted by name, whatever its version; a repo, whatever its ref; a folder, by its path. **Trusted Sources ›** in the tray lists them, and each can be stopped. Nothing's trusted until it's asked about — so trust a package that runs only itself, never one that runs whatever it's handed.

- **add** — keeps a launch, under **Launch ›**; it asks nothing, since nothing runs.
- **open** — runs a launch: its commands, or the ones named (asked, if it has several and none's given), once their sources are trusted — and keeps it too, with `keep`.

**Launch ›** in the tray runs a kept launch the same way. **Update available** shows when npm has a newer version — nothing is ever updated by itself.

## In userData

- `launches/` — the kept launches, one `.cmdless` file each, named after the launch. Changing the folder by hand changes the menu.
- `trusted.json` — the trusted sources.
- `logs/<launch>.log` — each launch's runs: its command lines and everything they printed.
- `launch-tray.log` — what the tray did.
