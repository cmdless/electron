# @cmdless/agent-runner

An example/dev app built on [`@cmdless/ui-sdk`](../../packages/ui-sdk), used to develop and exercise cmdless UI features against a real renderer. Shows an "agent picker" window via [`@cmdless/ui-runtime`](../ui-runtime).

## Layout

Renderer and node code live side by side under `src/`, built by two completely separate tools into two separate output directories so they never step on each other:

- `src/browser/` — the React renderer, built by Vite into `dist/`.
- `src/node/` — the CLI/bin side (`bin.ts`, `command.ts`), built by `tsc` into `out/`.
- `src/shared/` — code either side can import; included in both builds.

`tsconfig.browser.json` and `tsconfig.node.json` (referenced from the root `tsconfig.json`) mirror this split — `tsconfig.node.json` extends the monorepo's shared `tsconfig.base.json` like every other package here, with `rootDir: "./src"` / `outDir: "./out"`.

## Commands

- `npm run dev` — starts the Vite dev server, then (once it's actually listening) spawns `src/node/bin.ts` directly from source via `tsx` — no prior build needed — with the dev server's own URL published under `CmdlessEnv.url`, so the whole app runs end to end pointed at the dev server instead of the built renderer. See the `cmdless()` plugin in `vite.config.ts`.
- `npm run build` — `tsc -b` (node side → `out/`) then `vite build` (renderer → `dist/`).

## Dev loop signal handling

Because `dev` chains four processes (Vite → this app's own node bin → `ui-runtime`'s bin → Electron), `vite.config.ts`'s plugin listens for `SIGINT`/`SIGTERM` directly and forwards to its spawned child, rather than relying on Vite's own internal shutdown sequence to relay it (that path is both indirect - it depends on Vite's own graceful-close event actually completing before it exits - and unreliable in some terminals, e.g. VS Code's integrated terminal doesn't always propagate Ctrl+C to the whole process group). Each process in the chain does the same down to Electron, ensuring cleanup (an ephemeral session's `userData` directory) actually runs on exit either way.
