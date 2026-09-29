import { defineApp } from '../index.js';
import { createApp } from './index.js';

const spec = defineApp(({ tool, z }) => ({
  name: 'test-fixture-app',
  tools: {
    echo: tool('echo', 'Echo input', {
      input: z.object({ text: z.string() }),
      output: z.object({ text: z.string() }),
    }),
  },
}));

const createTestApp = createApp({
  spec,
  setup: () => ({
    echo: async ({ text }) => ({ text }),
  }),
});

export default createTestApp;

if (import.meta.url === `file://${process.argv[1]}`)
  await createTestApp().run();
