import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { CmdlessEnv } from '@cmdless/ui-sdk/node'

// Publishes the dev server's own URL under CmdlessEnv.url, then runs this
// project's own node-side bin directly from source (via tsx, so no prior
// build or install is needed) with that env var set - so "dev": "vite"
// alone runs the whole app end to end, pointed at the dev server instead
// of the built renderer.
function cmdless(): Plugin {
  let child: ChildProcess | undefined;
  const entry = fileURLToPath(new URL('./src/node/bin.ts', import.meta.url));

  return {
    name: 'cmdless',
    configureServer(server) {
      server.httpServer?.once('listening', () => {
        const url = server.resolvedUrls?.local?.[0];
        if (!url) return;

        child = spawn(process.execPath, ['--import', 'tsx', entry], {
          cwd: server.config.root,
          stdio: 'inherit',
          env: { ...process.env, [CmdlessEnv.URL_KEY]: url },
        });
        child.on('error', e => server.config.logger.error(`[cmdless] failed to spawn ${entry}: ${e}`));
        child.once('exit', (code, signal) => {
          server.config.logger.info(`[cmdless] bin exited (code=${code}, signal=${signal})`);
          process.off('SIGINT', forwardSignal);
          process.off('SIGTERM', forwardSignal);
          server.close().catch(() => { });
        });
      });

      // relying solely on vite's own httpServer 'close' event to relay a
      // signal here is unreliable (it depends on vite's own internal
      // shutdown sequence actually completing before this process exits,
      // and terminals like VS Code's integrated one don't always propagate
      // Ctrl+C to the whole process group anyway) - listen for the signal
      // directly instead, same as everywhere else in this chain.
      const forwardSignal = (signal: NodeJS.Signals) => child?.kill(signal);
      process.on('SIGINT', forwardSignal);
      process.on('SIGTERM', forwardSignal);
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  // don't let vite wipe the terminal - the spawned bin's inherited stdio
  // (and anything electron/ensure-electron prints) would get cleared with it.
  clearScreen: false,
  plugins: [react(), cmdless()],
})
