import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageChannel } from 'node:worker_threads';
import { defineProtocol } from '../protocol.js';
import { createBrowser, connectBrowser } from './connections.js';

test('connectBrowser round-trips over a postMessage-style port', async () => {
  const protocol = defineProtocol(({ side, request }) => ({
    clientToServer: side({
      requests: { ping: request<{ text: string }, { text: string }>('ping') },
    }),
  }));

  const { port1, port2 } = new MessageChannel();
  const server = protocol.createServer(createBrowser(port1 as never));
  const client = connectBrowser(protocol, port2 as never);

  server.onRequest.ping(({ text }) => ({ text: text.toUpperCase() }));
  server.listen();
  client.listen();

  try {
    const result = await client.request.ping({ text: 'hi' });
    assert.deepEqual(result, { text: 'HI' });
  } finally {
    client.dispose();
    server.dispose();
    port1.close();
  }
});
