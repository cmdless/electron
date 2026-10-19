# @cmdless/agent-runner

A dev app built on [`@cmdless/ui-sdk`](../../packages/ui-sdk), used to develop and exercise cmdless UI features against a real renderer. It's also a real, working example: `runAgent`, its main tool, runs a coding agent (Claude Code, Codex, or GitHub Copilot CLI) over [ACP](https://agentclientprotocol.com/) against a prompt and a working directory, showing UI for anything not given.

## Layout

Renderer and node code live side by side under `src/`, built by two completely separate tools into two separate output directories so they never step on each other:

- `src/node/` — the CLI/bin/MCP side, built by `tsc` into `out/`.
  - `app.ts` — `export default createApp({ spec, setup })`. Wires the tool handlers to the actual pickers/ACP logic below; imported and run by `bin.ts`, the package's only real entrypoint (`"bin"` in `package.json` points at it).
  - `acp.ts` — the [`@agentclientprotocol/sdk`](https://www.npmjs.com/package/@agentclientprotocol/sdk) integration: spawning an agent adapter, session lifecycle, config resolution, the headless and conversation-window output modes, and the `session/request_permission`/`elicitation/create` handlers.
  - `ui.ts` — the picker-window helpers (`createPicker`, `createInputPicker`, `pickerSource`) shared by `app.ts` and `acp.ts`.
  - `bin.ts` — `await createAgentRunner().run()`.
- `src/browser/` — the React renderer, built by Vite into `dist/`.
  - `router.tsx` — a tiny `useHashRoute()` hook; no router library, just a flat list of top-level views keyed by hash (`#/pick-agent`, `#/conversation`, etc.).
  - `routes/` — one component per view: `PickDirectory`, `PickPrompt`, `PickAgent` (plain forms, resolve via `window.cmdless.ipc.notify.resolve`), `Permission`/`Elicitation`/`Conversation` (connect over the window's own per-invocation WebSocket - see below). Currently fisher-price UI, enough to exercise the real wiring, not polished.
  - `useRpc.ts` — the connect-and-`listen()` hook used by `Permission`/`Elicitation`. `Conversation` rolls its own instead, since it needs its notification handlers registered *before* `listen()` (node starts streaming immediately on connect).
- `src/shared/` — code either side can import; included in both builds.
  - `app.ts` — the `defineApp` schema (see Tools below).
  - `protocols.ts` — `defineGetProtocol<T>()` (a one-request protocol factory, used by every picker that needs its invocation's input conveyed to its window) and `conversationProtocol` (the one genuinely bidirectional one).
  - `agents.ts` — `ACP_AGENTS`, the big three's package names, shared so `PickAgent` lists exactly what node resolves against.

`tsconfig.browser.json` and `tsconfig.node.json` (referenced from the root `tsconfig.json`) mirror this split — `tsconfig.node.json` extends the monorepo's shared `tsconfig.base.json` like every other package here, with `rootDir: "./src"` / `outDir: "./out"`.

## Tools

- `pickDirectory`, `pickPrompt`, `pickAgent` — each a plain picker window; cancelling throws (the caller never proceeds with a missing value).
- `runAgent` — the main tool. `directory`/`prompt`/`agent` are optional, resolved via the pickers above if missing, in that order (so cancelling any of them never leaves an ACP session behind — a session can only be created once all three are known). `model`/`mode`/`config` are *not* their own tool: ACP only reports a session's available config once the session itself exists (`session/new`'s response), so `runAgent` creates the session first, then either applies whatever was given explicitly (no UI) or shows a picker (`pickSessionConfig`/`SessionConfig.tsx`) fed by the session's own advertised modes/config options, each pre-selected to its current/default value (closing the window means "use the session's defaults", not cancel).
  - `outputType` (`'last-message'` default, or `'conversation'`) controls what happens next and what `output` holds, both always a plain string:
    - `'last-message'` — headless, no window: sends the prompt, waits for that turn, returns just its last distinct agent message.
    - `'conversation'` — opens a live window showing the session's turns and letting the user send follow-ups for as long as it stays open; closing it ends the run, and `output` holds the whole run's updates as one JSON-serialized array (not concatenated text, so a receiving end can actually parse it back out).
- `session/request_permission` and `elicitation/create` (ACP requests from the agent itself, not MCP tool calls) show their own pickers the same way, via a tiny ad hoc `RpcProtocol` per picker (`defineGetProtocol`) that conveys the real ACP request payload to the window - no generic "pass data into a shown window" mechanism needed, since `createShowCommand`'s `transport` already closes over the invocation's own input.

## Commands

- `npm run dev` — starts the Vite dev server, then (once it's actually listening) spawns `src/node/bin.ts` directly from source via `tsx` — no prior build needed — with the dev server's own URL published via `setCmdlessUrl`, so the whole app runs end to end pointed at the dev server instead of the built renderer. See the `cmdless()` plugin in `vite.config.ts`.
- `npm run build` — `tsc -b` (node side → `out/`) then `vite build` (renderer → `dist/`).

## Dev loop signal handling

Because `dev` chains four processes (Vite → this app's own node bin → `ui-runtime`'s bin → Electron), `vite.config.ts`'s plugin listens for `SIGINT`/`SIGTERM` directly and forwards to its spawned child, rather than relying on Vite's own internal shutdown sequence to relay it (that path is both indirect - it depends on Vite's own graceful-close event actually completing before it exits - and unreliable in some terminals, e.g. VS Code's integrated terminal doesn't always propagate Ctrl+C to the whole process group). Each process in the chain does the same down to Electron, ensuring cleanup (an ephemeral session's `userData` directory) actually runs on exit either way.

## Where this is at / what's next

Everything above is real and wired up (typechecked, built, and the renderer routes verified live in a browser), but two things are still open:

- **No real end-to-end run yet.** Nothing here has actually been exercised against a live Claude/Codex/Copilot subprocess, and there are no automated tests for `acp.ts`/`app.ts`/`ui.ts` (unlike `ui-sdk`'s core, which has real fixture/subprocess tests). Everything's verified by typecheck/build/test plus a static browser preview of the renderer - the ACP wiring itself is unproven in practice.
- **Windows opened by the same `runAgent` call aren't parented to each other.** `pickDirectory`/`pickPrompt`/`pickAgent` are strictly sequential (never open at once, so parenting wouldn't do anything there), but `showConversation` can stay open while `pickPermission`/`pickElicitation` pop up mid-conversation - those *are* concurrent, and currently unrelated windows. The fix isn't `BinChannel` (that's internal to `ui-runtime`'s own bin↔main split and never reaches this process in time - `execProcess`/`runAsRuntime` only exposes buffered stdout-at-exit). It's `conversationProtocol`: the renderer already learns its own `windowId` via `connectionInfo()`; it just needs to report that back over the connection it already has open, so `acp.ts`'s `configure(peer)` can capture it and `pickPermission`/`pickElicitation` can pass it as `parent` when they fire mid-conversation.
