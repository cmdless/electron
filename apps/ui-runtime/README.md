# @cmdless/ui-runtime

The actual Electron app behind cmdless UI. It's an Electron app without a renderer of its own — the caller provides one (a URL or a file) if they need it.

Normally you don't run this directly; [`@cmdless/ui`](../ui) caches and forwards to it. It's a separate package because the two have very different dependencies: `@cmdless/ui` is a plain Node CLI, while this one needs Electron itself.

## Commands

- `show <url|file> <source>` — open a `BrowserWindow` loading a URL or a local file.
- `message-box <type> <message>` — show a native message box.

Both accept `--app <name>` to group windows/dialogs under one Electron app identity — matching names share a `userData` profile and are single-instanced; omitting it creates a throwaway, self-cleaning ephemeral session for that one invocation.

## How it resolves

Each invocation resolves to a single value (whatever the window or dialog produced) and exits. The wrapper CLI (`bin.ts`) talks to the actual Electron process over a `BinChannel` (a small local-socket protocol from [`@cmdless/ui-sdk/node`](../../packages/ui-sdk)) — not stdout, and deliberately not Node's `child_process` `'ipc'` stdio channel either. `'ipc'` is a documented source of `app.whenReady()` hangs when combined with Electron ([electron/electron#17044](https://github.com/electron/electron/issues/17044)); a plain socket avoids that while still keeping anything Electron itself logs out of the value being returned.
