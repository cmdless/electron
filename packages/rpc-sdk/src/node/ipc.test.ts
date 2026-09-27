import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defineProtocol } from '../protocol.js';
import { createIPC } from './connections.js';

test('createIPC round-trips over a real child_process IPC channel', async () => {
  const fixture = fileURLToPath(new URL('./ipc.fixture.ts', import.meta.url));
  const child = fork(fixture, [], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });

  const protocol = defineProtocol(({ side, request }) => ({
    clientToServer: side({
      requests: { ping: request<{ text: string }, { text: string }>('ping') },
    }),
  }));

  const peer = protocol.createClient(createIPC(child));
  peer.listen();

  try {
    const result = await peer.request.ping({ text: 'hi' });
    assert.deepEqual(result, { text: 'HI' });
  } finally {
    peer.dispose();
    child.kill();
  }
});
