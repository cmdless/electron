import test from 'node:test';
import assert from 'node:assert/strict';
import { defineApp } from '../index.js';
import { createApp } from './index.js';

test('createApp: tools are directly callable in-process', async () => {
  const spec = defineApp(({ tool, z }) => ({
    name: 'test-app',
    tools: {
      launch: tool('launch', 'Launch an agent', {
        input: z.object({ name: z.string(), count: z.number().optional() }),
        output: z.object({ pid: z.number() }),
      }),
    },
  }));

  const app = createApp({
    spec,
    setup: () => ({
      launch: async ({ name, count }) => ({ pid: name.length + (count ?? 0) }),
    }),
  })();

  assert.deepEqual(await app.tools.launch({ name: 'x', count: 3 }), { pid: 4 });
  assert.equal(app.spec.name, 'test-app');
});

test('createApp: setup runs once per instance, so handlers share its closed-over state', async () => {
  const spec = defineApp(({ tool, z }) => ({
    name: 'test-app',
    tools: {
      increment: tool('increment', 'Increment a counter', {
        input: z.object({}),
        output: z.object({ count: z.number() }),
      }),
    },
  }));

  const createCounterApp = createApp({
    spec,
    setup: () => {
      let count = 0;
      return {
        increment: async () => ({ count: ++count }),
      };
    },
  });

  const app1 = createCounterApp();
  assert.deepEqual(await app1.tools.increment({}), { count: 1 });
  assert.deepEqual(await app1.tools.increment({}), { count: 2 });

  const app2 = createCounterApp();
  assert.deepEqual(await app2.tools.increment({}), { count: 1 });
});

function makeLaunchApp() {
  const spec = defineApp(({ tool, z }) => ({
    name: 'test-app',
    tools: {
      launch: tool('launch', 'Launch an agent', {
        input: z.object({ name: z.string(), count: z.number().optional() }),
        output: z.object({ pid: z.number() }),
      }),
    },
  }));
  return createApp({
    spec,
    setup: () => ({
      launch: async ({ name, count }) => ({ pid: name.length + (count ?? 0) }),
    }),
  })();
}

async function runCapturingStdout(app: { run: (argv: string[]) => Promise<void> }, args: string[]) {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => { chunks.push(chunk); return true; }) as typeof process.stdout.write;
  try {
    await app.run(['node', 'bin', ...args]);
  } finally {
    process.stdout.write = original;
  }
  return chunks.join('');
}

test('cli: flags alone are parsed and validated', async () => {
  const output = await runCapturingStdout(makeLaunchApp(), ['tool', 'launch', '--name', 'agent1', '--count', '5']);
  assert.deepEqual(JSON.parse(output), { pid: 11 });
});

test('cli: JSON positional alone is parsed and validated', async () => {
  const output = await runCapturingStdout(makeLaunchApp(), ['tool', 'launch', '{"name":"agent2"}']);
  assert.deepEqual(JSON.parse(output), { pid: 6 });
});

test('cli: flags override matching fields from the JSON positional', async () => {
  const output = await runCapturingStdout(makeLaunchApp(), [
    'tool', 'launch', '{"name":"agent3","count":1}', '--count', '99',
  ]);
  assert.deepEqual(JSON.parse(output), { pid: 105 });
});

test('cli: an object/record field can be set as a flag, parsed as JSON', async () => {
  const spec = defineApp(({ tool, z }) => ({
    name: 'test-app',
    tools: {
      configure: tool('configure', 'Apply config', {
        input: z.object({ config: z.record(z.string(), z.string()).optional() }),
        output: z.object({ config: z.record(z.string(), z.string()).optional() }),
      }),
    },
  }));

  const app = createApp({
    spec,
    setup: () => ({
      configure: async ({ config }) => ({ config }),
    }),
  })();

  const output = await runCapturingStdout(app, ['tool', 'configure', '--config', '{"reasoning":"high"}']);
  assert.deepEqual(JSON.parse(output), { config: { reasoning: 'high' } });
});

test('cli: startup runs on no subcommand and receives the app itself', async () => {
  const spec = defineApp(({ tool, z }) => ({
    name: 'test-app',
    tools: {
      launch: tool('launch', 'Launch an agent', {
        input: z.object({ name: z.string() }),
        output: z.object({ pid: z.number() }),
      }),
    },
  }));

  let received: unknown;
  const app = createApp({
    spec,
    setup: () => ({
      launch: async ({ name }) => ({ pid: name.length }),
    }),
    startup: async receivedApp => {
      received = await receivedApp.tools.launch({ name: 'from-startup' });
    },
  })();

  await app.run(['node', 'bin']);
  assert.deepEqual(received, { pid: 12 });
});

test('cli: startup does not run when a subcommand is given', async () => {
  const spec = defineApp(({ tool, z }) => ({
    name: 'test-app',
    tools: {
      launch: tool('launch', 'Launch an agent', {
        input: z.object({ name: z.string() }),
        output: z.object({ pid: z.number() }),
      }),
    },
  }));

  let startupCalled = false;
  const app = createApp({
    spec,
    setup: () => ({
      launch: async ({ name }) => ({ pid: name.length }),
    }),
    startup: () => { startupCalled = true; },
  })();

  await runCapturingStdout(app, ['tool', 'launch', '{"name":"x"}']);
  assert.equal(startupCalled, false);
});

test('cli: invalid input is rejected without calling the handler', async () => {
  let called = false;
  const spec = defineApp(({ tool, z }) => ({
    name: 'test-app',
    tools: {
      launch: tool('launch', 'Launch an agent', {
        input: z.object({ name: z.string() }),
        output: z.object({ pid: z.number() }),
      }),
    },
  }));
  const app = createApp({
    spec,
    setup: () => ({
      launch: async () => { called = true; return { pid: 0 }; },
    }),
  })();

  const originalExitCode = process.exitCode;
  const originalError = console.error;
  console.error = () => { };
  try {
    await app.run(['node', 'bin', 'tool', 'launch', '{}']);
    assert.equal(process.exitCode, 1);
    assert.equal(called, false);
  } finally {
    console.error = originalError;
    process.exitCode = originalExitCode;
  }
});
