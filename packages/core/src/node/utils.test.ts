import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveService, waitForService } from './utils.js';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'service.fixture.ts');
const run = (...args: string[]): [string, string[]] => [process.execPath, ['--import', 'tsx', fixture, ...args]];

test('waitForService resolves with the value the child reports, leaving it running', async () => {
  const { child, value } = await waitForService<{ pid: number; args: string[] }>(...run('resolve', 'a', 'b'));
  try {
    assert.equal(value.pid, child.pid);
    assert.deepEqual(value.args, ['a', 'b']);
    assert.equal(child.exitCode, null);
  } finally {
    child.kill();
  }
});

test('waitForService rejects with the error the child reports', async () => {
  await assert.rejects(waitForService(...run('reject')), /could not start/);
});

test('waitForService rejects when the child exits before reporting', async () => {
  await assert.rejects(waitForService(...run('exit')), /exited \(3\) before resolving/);
});

test('waitForService rejects on timeout and kills the child', async () => {
  await assert.rejects(waitForService(...run('silent'), { timeoutMs: 1 }), /did not resolve as a service within 1ms/);
});

test('resolveService throws outside of waitForService', () => {
  assert.throws(() => resolveService(1), /was this process started by waitForService/);
});
