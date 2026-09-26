import 'vscode-jsonrpc/node'; // installs the Node runtime abstraction layer these tests run under
import test from 'node:test';
import assert from 'node:assert/strict';
import { defineProtocol } from './protocol.js';
import { createCallback } from './connections.js';
import type { DataCallback } from './connections.js';

function createLoopbackPair() {
  let clientCallback: DataCallback | undefined;
  let serverCallback: DataCallback | undefined;

  const clientConn = createCallback(
    { subscribe: callback => { clientCallback = callback; return () => { clientCallback = undefined; }; } },
    { send: message => serverCallback?.(message) },
  );
  const serverConn = createCallback(
    { subscribe: callback => { serverCallback = callback; return () => { serverCallback = undefined; }; } },
    { send: message => clientCallback?.(message) },
  );

  return { clientConn, serverConn };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test('a request round-trips with the correct params and result types', async () => {
  const protocol = defineProtocol(({ side, request }) => ({
    clientToServer: side({
      requests: { ping: request<{ text: string }, { text: string }>('ping') },
    }),
  }));

  const { clientConn, serverConn } = createLoopbackPair();
  const client = protocol.createClient(clientConn);
  const server = protocol.createServer(serverConn);

  server.onRequest.ping(async ({ text }) => ({ text: text.toUpperCase() }));
  client.listen();
  server.listen();

  const result = await client.request.ping({ text: 'hello' });
  assert.deepEqual(result, { text: 'HELLO' });
});

test('a notification flows from client to server', async () => {
  const protocol = defineProtocol(({ side, notification }) => ({
    clientToServer: side({
      notifications: { ping: notification<{ n: number }>('ping') },
    }),
  }));

  const { clientConn, serverConn } = createLoopbackPair();
  const client = protocol.createClient(clientConn);
  const server = protocol.createServer(serverConn);

  const received: number[] = [];
  server.onNotification.ping(({ n }) => { received.push(n); });
  client.listen();
  server.listen();

  client.notify.ping({ n: 1 });
  await tick();

  assert.deepEqual(received, [1]);
});

test('disposing a notification handler stops it from firing', async () => {
  const protocol = defineProtocol(({ side, notification }) => ({
    clientToServer: side({
      notifications: { ping: notification<{ n: number }>('ping') },
    }),
  }));

  const { clientConn, serverConn } = createLoopbackPair();
  const client = protocol.createClient(clientConn);
  const server = protocol.createServer(serverConn);

  const received: number[] = [];
  const disposable = server.onNotification.ping(({ n }) => { received.push(n); });
  client.listen();
  server.listen();

  client.notify.ping({ n: 1 });
  await tick();
  disposable.dispose();

  client.notify.ping({ n: 2 });
  await tick();

  assert.deepEqual(received, [1]);
});
