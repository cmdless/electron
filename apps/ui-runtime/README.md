# @cmdless/ui-runtime

The actual Electron app behind cmdless UI. Windows show the caller's own page (a URL or a file); cards and forms show the host's own page, which draws an [Adaptive Card](https://adaptivecards.io) or a JSON Schema form ([react-jsonschema-form](https://rjsf-team.github.io/react-jsonschema-form/), in Mantine).

Normally you don't run this directly: `UIHost` in [`@cmdless/ui-sdk/node`](../../packages/ui-sdk) starts it, and [`@cmdless/ui`](../ui)'s one-shot commands go through `UIHost`. It's a separate package because it needs Electron itself.

## Command

- `host` — run the host for an app. It takes no arguments: the app's name comes from `CMDLESS_APP` (left out, a throwaway one is made), the cmdless root from `CMDLESS_ROOT`, and where to report its address from `CMDLESS_SERVICE_SOCKET` (set by `waitForService`).

## How it hosts

Electron main is itself the host: it takes the app's single-instance lock, serves the `UIHost` protocol on a local socket, and reports the address to whoever started it. `UIHost`s connect there to open windows, dialogs, cards, forms, trays and notifications, each tracked as a handle that ends with a value.

- **One host per app name.** A host started for an app that's already running loses the lock and hands the running one a reply socket; the running host answers once its owner has connected, and the loser passes the address on to its own creator before quitting.
- **The owner decides its lifetime.** The first `UIHost` to connect — the one whose creator started the process that got the lock — owns the host, and the host quits when it disconnects. Everything another `UIHost` opened goes with it.
- **Throwaway hosts clean up after themselves.** An app with no name gets a throwaway one under temp; a small process (`cleanup.ts`) that outlives the host removes its `userData` once it's gone, however it ends.
- **The Dock icon** shows only while a window or dialog is open; trays live outside it.
- **A tray given no icon** (an empty string) gets the runtime's own, `resources/trayTemplate.png`.
- **A named app goes by its own name** (`platform.ts`), without any npm scope (`@cmdless/gh-approvals` shows as `gh-approvals`), and by `dev.cmdless.<name>` as its id (`dev.cmdless.gh-approvals`); a throwaway one stays "Electron". The name alone changes nothing else: the app name, with its scope, is still the lock and names `userData`.
  - macOS reads the name from the app bundle, so the host runs from the app's own copy of Electron's: `<root>/apps/<app>/bundles/<electron version>/<name>.app`, renamed and re-signed, with its executable renamed too, so `ps` and Activity Monitor show the name. The helpers stay `Electron Helper`. It's an APFS clone of the stock bundle, made once per Electron version, so it takes only a few hundred KB. If it can't be made (another volume, say), the host runs as Electron. Being its own bundle id, the app asks for notification permission once on its own.
  - Windows and Linux (both untested) name a process by its executable, so the host runs from `<root>/apps/<app>/bundles/<electron version>/<name>/`: Electron's folder as hard links, which take no space, with the executable renamed `<name>.exe` or `<name>`. Hard links can't cross volumes either, and the host runs as Electron if they fail.
  - Windows also takes the id as the process's AppUserModelID, and a Start Menu shortcut carrying it (`Programs\cmdless\<name>.lnk`) names the app's notifications. Launching the shortcut itself doesn't open anything useful yet.
  - Linux matches windows to a hidden `.desktop` file, written to `~/.local/share/applications/dev.cmdless.<name>.desktop`.

- **Windows are sandboxed.** A window's page gets `window.cmdless` from the preload and nothing else. A window opened with a backend is told so at start, and its preload connects as the page loads: the host asks the window's `UIHost` for it by the key it was opened with, which answers with a loopback WebSocket address and a token for one connection; the preload connects with it, and the page only ever sees a socket to send and hear messages on.
- **The host's own page** (`src/renderer`) draws cards and forms. Its content security policy allows no eval: the form validates with `@cfworker/json-schema` rather than ajv. It never navigates, links open in the browser, and Markdown in card text is rendered with raw HTML escaped. A card can hold a JSON Schema form as an input (`Input.JsonSchema`), which is how elicitation is asked. The page measures its content and the window fits its height to it.

On macOS a message box with no parent window is app-modal, as any native alert is: only the user can end it, and code can't close it. Cocoa won't let an app quit while one is up, so a host told to quit then (its owner gone, or a signal) quits as soon as it's answered. One opened from a window is a sheet on it, and can be closed.
