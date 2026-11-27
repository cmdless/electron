# @cmdless/launch-tray

The tray `.cmdless` files open through. [ui-runtime's launcher](../ui-runtime#the-launcher) passes each file it's given here; this keeps the ones you've trusted, and runs them.

```
launch-tray [add <file> | open <file>]
```

The first run is the tray, under its own app name (`@cmdless/launch-tray`); any run after it hands its file to the running one and exits. The tray takes no file until it's set itself up, so nothing handed to it is missed.

- `add <file>` — keep a launch. One from outside the tray's own folder is shown first, with exactly what it runs, and kept only if you choose **Add** (or **Replace**, for a name that's already kept).
- `open <file>` — run one. A kept launch runs at once; any other is asked about as `add` would, and runs once it's kept.

**Launch ›** in the tray lists the kept launches; choosing one runs it. **Update available** shows when npm has a newer version — nothing is ever updated by itself.

## .cmdless files

JSON: a name, and the commands that launch it, run in order.

```json
{
  "name": "gh-approvals",
  "commands": [
    { "command": "npx", "args": ["-y", "@cmdless/gh-approvals@latest", "--background"] }
  ]
}
```

Each command runs detached, in the home folder, so whatever it starts outlives the tray; the first that fails (or can't start) ends the launch, and the tray says so with a notification.

## In userData

- `launches/` — the kept launches, one `.cmdless` file each, named after the launch. Changing the folder by hand changes the menu.
- `logs/<launch>.log` — each launch's runs: its commands and everything they printed.
- `launch-tray.log` — what the tray did.
