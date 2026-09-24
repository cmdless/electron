# @cmdless/ui-sdk

Shared types and helpers for building on cmdless UI. Everything a consumer or a `@cmdless/ui-runtime` build needs, split by where it runs.

## Exports

- **`@cmdless/ui-sdk/node`** — for the process invoking cmdless UI (or the Electron main process handling it). `CmdlessUI` dispatches `show`/`message-box` requests — by default by spawning `@cmdless/ui-runtime`, or with a custom `dispatch` for handling a request in-process (e.g. a window's own preload asking for a nested dialog). Also package-caching helpers (`ensurePackage`, `runAsPackage`, `runAsRuntime`) and `CmdlessEnv` for the `CMDLESS_ROOT`/`CMDLESS_TOKEN` environment variables.
- **`@cmdless/ui-sdk`** — platform-agnostic: the `Params`/`ShowParams`/`MessageBoxParams` types, `cmdlessProtocol` (the [`@cmdless/rpc-sdk`](../rpc-sdk) protocol definition shared between a window's preload and the Electron main process), `createElectronIPC`, and a small typed `Emitter` used internally.
- **`@cmdless/ui-sdk/browser`** — for code running in a cmdless-hosted window. `CmdlessRenderer` wraps `window.cmdless`, the object the preload script exposes.
