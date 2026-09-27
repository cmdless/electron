import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { defineProtocol } from '../protocol.js';
import { connectStdio } from './connections.js';

test('startStdio/connectStdio round-trips over a real child process', async () => {
  const fixture = fileURLToPath(new URL('./stdio.fixture.ts', import.meta.url));
  const protocol = defineProtocol(({ side, request }) => ({
    clientToServer: side({
      requests: { ping: request<{ text: string }, { text: string }>('ping') },
    }),
  }));

  const peer = connectStdio(protocol, { command: process.execPath, args: ['--import', 'tsx', fixture] });
  peer.listen();

  try {
    const result = await peer.request.ping({ text: 'hi' });
    assert.deepEqual(result, { text: 'HI' });
  } finally {
    peer.dispose();
  }
});
