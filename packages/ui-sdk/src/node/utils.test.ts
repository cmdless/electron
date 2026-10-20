import test from 'node:test';
import assert from 'node:assert/strict';
import { defineProtocol } from '@cmdless/rpc-sdk';
import { connectWebSocket } from '@cmdless/rpc-sdk/ws';
import { CmdlessUI, createShowCommand, getCmdlessUrl, getPackageName, setCmdlessUrl } from './utils.js';
import type * as types from '../types.js';

test('getPackageName splits a scoped specifier with a version', () => {
  assert.deepEqual(getPackageName('@cmdless/ui-runtime@0.0.3'), {
    packageName: '@cmdless/ui-runtime',
    packageVersion: '0.0.3',
  });
});

test('getPackageName leaves an unversioned specifier alone', () => {
  assert.deepEqual(getPackageName('@cmdless/ui-runtime'), {
    packageName: '@cmdless/ui-runtime',
  });
});

test('getPackageName treats an explicit "latest" the same as no version', () => {
  assert.deepEqual(getPackageName('@cmdless/ui-runtime@latest'), {
    packageName: '@cmdless/ui-runtime',
  });
});

test('getPackageName treats "latest" case-insensitively', () => {
  assert.deepEqual(getPackageName('@cmdless/ui-runtime@LATEST'), {
    packageName: '@cmdless/ui-runtime',
  });
});

test('CmdlessUI.toArgs builds show argv with only the provided options', () => {
  const args = CmdlessUI.toArgs({
    kind: 'show',
    type: 'url',
    source: 'https://example.com',
    app: 'agent-picker',
  });
  assert.deepEqual(args, ['show', 'url', 'https://example.com', '--app', 'agent-picker']);
});

test('CmdlessUI.toArgs omits options that were not provided', () => {
  const args = CmdlessUI.toArgs({
    kind: 'show',
    type: 'file',
    source: '/tmp/index.html',
  });
  assert.deepEqual(args, ['show', 'file', '/tmp/index.html']);
});

test('CmdlessUI.toArgs builds message-box argv', () => {
  const args = CmdlessUI.toArgs({
    kind: 'message-box',
    type: 'warning',
    message: 'are you sure?',
  });
  assert.deepEqual(args, ['message-box', 'warning', 'are you sure?']);
});

test('createShowCommand: a dev CMDLESS_URL override preserves the original source\'s hash route', async () => {
  let seen: types.ShowParams | undefined;
  const dispatcher = async (parameters: types.Params) => {
    seen = parameters as types.ShowParams;
    return 'ok';
  };

  const show = createShowCommand({
    params: () => ({ type: 'file', source: '/dist/index.html#/pick-agent' }),
    dispatcher,
  });

  const originalUrl = getCmdlessUrl();
  setCmdlessUrl('http://localhost:5173/');
  try {
    await show();
  } finally {
    setCmdlessUrl(originalUrl);
  }

  assert.equal(seen?.type, 'url');
  assert.equal(seen?.source, 'http://localhost:5173/#/pick-agent');
});

test('createShowCommand: a dev CMDLESS_URL override with no hash in the original source is used as-is', async () => {
  let seen: types.ShowParams | undefined;
  const dispatcher = async (parameters: types.Params) => {
    seen = parameters as types.ShowParams;
    return 'ok';
  };

  const show = createShowCommand({
    params: () => ({ type: 'file', source: '/dist/index.html' }),
    dispatcher,
  });

  const originalUrl = getCmdlessUrl();
  setCmdlessUrl('http://localhost:5173/');
  try {
    await show();
  } finally {
    setCmdlessUrl(originalUrl);
  }

  assert.equal(seen?.source, 'http://localhost:5173/');
});

test('createShowCommand: the window connection only admits the token in its address', async () => {
  const protocol = defineProtocol(({ side, request }) => ({
    clientToServer: side({ requests: { get: request<void, string>('get') } }),
  }));

  const tryOpen = (url: string) => new Promise<string>(resolve => {
    const socket = new WebSocket(url);
    socket.onopen = () => { socket.close(); resolve('open'); };
    socket.onerror = () => resolve('refused');
  });

  const results: Record<string, string> = {};
  const show = createShowCommand<void, void>({
    params: () => ({ type: 'file', source: '/dist/index.html' }),
    transport: async () => {
      const { accept } = await protocol.defineHost({ configure: server => server.onRequest.get(() => 'hello') })();
      return { accept, options: { port: 0, host: '127.0.0.1' } };
    },
    // stands in for the window: tries the address without its token, with a
    // wrong one, and as given
    dispatcher: async parameters => {
      const address = (parameters as types.ShowParams).address!;
      const bare = address.replace(/\?.*$/, '');
      results.missing = await tryOpen(bare);
      results.wrong = await tryOpen(`${bare}?token=nope`);
      const client = await connectWebSocket(protocol, { url: address });
      client.listen();
      results.given = await client.request.get();
      client.dispose();
      return '';
    },
    result: () => undefined,
  });

  await show();
  assert.deepEqual(results, { missing: 'refused', wrong: 'refused', given: 'hello' });
});
