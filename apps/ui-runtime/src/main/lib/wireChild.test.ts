import test from 'node:test';
import assert from 'node:assert/strict';
import { wireChild } from './wireChild.js';

test('writes the resolved value to stdout on a resolve message', () => {
  const written: string[] = [];
  const { onMessage } = wireChild(text => written.push(text), () => { throw new Error('should not clean up'); });

  onMessage({ type: 'resolve', value: 'hello' });
  assert.deepEqual(written, ['hello']);
});

test('a null resolve value is not written', () => {
  const written: string[] = [];
  const { onMessage } = wireChild(text => written.push(text), () => { });

  onMessage({ type: 'resolve', value: null });
  assert.deepEqual(written, []);
});

test('cleanup only runs after exit, not when the cleanup message arrives', () => {
  const removed: string[] = [];
  const { onMessage, onExit } = wireChild(() => { }, path => removed.push(path));

  onMessage({ type: 'cleanup', appName: '.cmdless.ui/abc', userData: '/tmp/abc' });
  assert.deepEqual(removed, []);

  onExit(0);
  assert.deepEqual(removed, ['/tmp/abc']);
});

test('no cleanup call when nothing was ever marked for cleanup', () => {
  const removed: string[] = [];
  const { onExit } = wireChild(() => { }, path => removed.push(path));

  onExit(0);
  assert.deepEqual(removed, []);
});

test('sets process.exitCode from the exit code, defaulting to 1', () => {
  const originalExitCode = process.exitCode;
  try {
    const { onExit } = wireChild(() => { }, () => { });

    onExit(null);
    assert.equal(process.exitCode, 1);

    onExit(3);
    assert.equal(process.exitCode, 3);
  } finally {
    process.exitCode = originalExitCode;
  }
});
