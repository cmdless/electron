# @cmdless/ui-runtime

The actual Electron app behind cmdless UI. It's an Electron app without a renderer of its own — the caller provides one (a URL or a file) if they need it.

Normally you don't run this directly; [`@cmdless/ui`](../ui) caches and forwards to it. It's a separate package because the two have very different dependencies: `@cmdless/ui` is a plain Node CLI, while this one needs Electron itself.

## Commands

- `show <url|file> <source>` — open a `BrowserWindow` loading a URL or a local file.
- `message-box <type> <message>` — show a native message box.

Both accept `--app <name>` to group windows/dialogs under one Electron app identity — matching names share a `userData` profile and are single-instanced; omitting it creates a throwaway, self-cleaning ephemeral session for that one invocation.

## How it resolves

Each invocation resolves to a single value (whatever the window or dialog produced) and exits. The wrapper CLI (`bin.ts`) talks to the actual Electron process over an `ipc` channel — not stdout — specifically so that anything Electron itself logs can't get mixed in with the value being returned.
