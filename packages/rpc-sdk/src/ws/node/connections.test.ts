import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { defineProtocol } from '../../protocol.js';
import type { RpcPeer } from '../../protocol.js';
import { connectWebSocket } from '../connections.js';
import { startWebSocket } from './connections.js';

test('startWebSocket/connectWebSocket round-trip over a real WebSocket', async () => {
  const protocol = defineProtocol(({ side, request }) => ({
    clientToServer: side({
      requests: { ping: request<{ text: string }, { text: string }>('ping') },
    }),
  }));

  let serverPeer: RpcPeer | undefined;
  const { accept } = await protocol.defineHost({
    configure(peer) {
      serverPeer = peer;
      peer.onRequest.ping(async ({ text }) => ({ text: text.toUpperCase() }));
    },
  })();
  const server = await startWebSocket({ accept, options: { port: 0, host: '127.0.0.1' } });

  const { port } = server.address() as AddressInfo;
  const client = await connectWebSocket(protocol, { url: `ws://127.0.0.1:${port}` });

  try {
    client.listen();
    const result = await client.request.ping({ text: 'hi' });
    assert.deepEqual(result, { text: 'HI' });
  } finally {
    client.dispose();
    serverPeer?.dispose();
    server.close();
  }
});
