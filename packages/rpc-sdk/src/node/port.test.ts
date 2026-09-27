import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageChannel } from 'node:worker_threads';
import { defineProtocol } from '../protocol.js';
import { createPort } from './connections.js';

test('createPort round-trips over a real MessageChannel', async () => {
  const protocol = defineProtocol(({ side, request }) => ({
    clientToServer: side({
      requests: { ping: request<{ text: string }, { text: string }>('ping') },
    }),
  }));

  const { port1, port2 } = new MessageChannel();
  const server = protocol.createServer(createPort(port1));
  const client = protocol.createClient(createPort(port2));

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
