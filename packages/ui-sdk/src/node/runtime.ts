import { runtimeSpec } from '../runtime.js';
import { createApp } from './app.js';
import { CmdlessUI } from './utils.js';

// node-side wiring for runtimeSpec - handlers just forward straight
// through to the existing CmdlessUI + dispatcher (unchanged default:
// spawns @cmdless/ui-runtime via runAsRuntime), so this carries no
// behavior of its own - it's a schema/CLI/MCP front door onto what already
// happens for every show/message-box dispatch today.
const createRuntimeApp = createApp({
  spec: runtimeSpec,
  setup: () => {
    const ui = new CmdlessUI();
    return {
      show: async input => ({ output: await ui.show({ kind: 'show', ...input }) }),
      messageBox: async input => ({ output: await ui.messageBox({ kind: 'message-box', ...input }) }),
    };
  },
});

export default createRuntimeApp;
