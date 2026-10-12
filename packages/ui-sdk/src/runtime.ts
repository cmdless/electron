import { defineApp } from './app.js';
import { ShowParamsSchema, MessageBoxParamsSchema } from './types.js';

// reuses the exact schemas ui-runtime's own dispatcher already accepts
// (ShowParams/MessageBoxParams) - just `kind` omitted, since the tool name
// already says which one this is. Schema only, same as every other
// defineApp - the node-side wiring (node/runtime.js) forwards straight
// through to the existing CmdlessUI + dispatcher, unchanged.
export const runtimeSpec = defineApp(({ tool, z }) => ({
  name: 'ui-sdk',
  description: 'Basic UI primitives (show a window, show a message box) for showing something to the user',
  tools: {
    show: tool('show', 'Show a window loading a URL or a local file', {
      input: ShowParamsSchema.omit({ kind: true }),
      output: z.object({ output: z.string() }),
    }),
    messageBox: tool('messageBox', 'Show a native message box', {
      input: MessageBoxParamsSchema.omit({ kind: true }),
      output: z.object({ output: z.string() }),
    }),
  },
}));
