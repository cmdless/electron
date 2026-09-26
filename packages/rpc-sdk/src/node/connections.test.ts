import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { defineProtocol } from '../protocol.js';
import type { RpcPeer } from '../protocol.js';
import { startSocket, connectSocket } from './connections.js';

test('startSocket/connectSocket round-trip over a real TCP socket', async () => {
  const protocol = defineProtocol(({ side, request }) => ({
    clientToServer: side({
      requests: { ping: request<{ text: string }, { text: string }>('ping') },
    }),
  }));

  let serverPeer: RpcPeer | undefined;
  const server = await startSocket({
    protocol,
    options: { port: 0, host: '127.0.0.1' },
    configure(peer) {
      serverPeer = peer;
      peer.onRequest.ping(async ({ text }) => ({ text: text.toUpperCase() }));
    },
  });

  const { port } = server.address() as AddressInfo;
  const client = await connectSocket(protocol, { port, host: '127.0.0.1' });

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
