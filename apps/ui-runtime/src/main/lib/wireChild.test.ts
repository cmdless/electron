import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { wireChild } from './wireChild.js';

function fakeChild() {
  return new EventEmitter();
}

test('writes the resolved value to stdout on a resolve message', () => {
  const child = fakeChild();
  const written: string[] = [];
  wireChild(child, text => written.push(text), () => { throw new Error('should not clean up'); });

  child.emit('message', { type: 'resolve', value: 'hello' });
  assert.deepEqual(written, ['hello']);
});

test('a null resolve value is not written', () => {
  const child = fakeChild();
  const written: string[] = [];
  wireChild(child, text => written.push(text), () => { });

  child.emit('message', { type: 'resolve', value: null });
  assert.deepEqual(written, []);
});

test('cleanup only runs after exit, not when the cleanup message arrives', () => {
  const child = fakeChild();
  const removed: string[] = [];
  wireChild(child, () => { }, path => removed.push(path));

  child.emit('message', { type: 'cleanup', appName: '.cmdless.ui/abc', userData: '/tmp/abc' });
  assert.deepEqual(removed, []);

  child.emit('exit', 0);
  assert.deepEqual(removed, ['/tmp/abc']);
});

test('no cleanup call when nothing was ever marked for cleanup', () => {
  const child = fakeChild();
  const removed: string[] = [];
  wireChild(child, () => { }, path => removed.push(path));

  child.emit('exit', 0);
  assert.deepEqual(removed, []);
});

test('sets process.exitCode from the exit code, defaulting to 1', () => {
  const originalExitCode = process.exitCode;
  try {
    const child = fakeChild();
    wireChild(child, () => { }, () => { });

    child.emit('exit', null);
    assert.equal(process.exitCode, 1);

    child.emit('exit', 3);
    assert.equal(process.exitCode, 3);
  } finally {
    process.exitCode = originalExitCode;
  }
});
