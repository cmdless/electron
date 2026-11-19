import test from 'node:test';
import assert from 'node:assert/strict';
import { execProcess, getPackageName } from './packages.js';

test('execProcess resolves with what the command printed', async () => {
  assert.equal(await execProcess(process.execPath, ['-e', 'console.log("hi")'], process.env), 'hi');
});

test('aborting execProcess stops the command and rejects with the reason', async () => {
  const controller = new AbortController();
  const started = Date.now();
  const running = execProcess(process.execPath, ['-e', 'setTimeout(() => {}, 10_000)'], process.env, controller.signal);
  setTimeout(() => controller.abort(new Error('closed')), 100);
  await assert.rejects(running, /closed/);
  assert.ok(Date.now() - started < 5_000);
});

test('getPackageName splits a scoped specifier with a version', () => {
  assert.deepEqual(getPackageName('@cmdless/ui-runtime@0.0.3'), {
    packageName: '@cmdless/ui-runtime',
    packageVersion: '0.0.3',
  });
});

test('getPackageName leaves an unversioned specifier alone', () => {
  assert.deepEqual(getPackageName('@cmdless/ui-runtime'), {
    packageName: '@cmdless/ui-runtime',
  });
});

test('getPackageName treats an explicit "latest" the same as no version', () => {
  assert.deepEqual(getPackageName('@cmdless/ui-runtime@latest'), {
    packageName: '@cmdless/ui-runtime',
  });
});

test('getPackageName treats "latest" case-insensitively', () => {
  assert.deepEqual(getPackageName('@cmdless/ui-runtime@LATEST'), {
    packageName: '@cmdless/ui-runtime',
  });
});
