import test from 'node:test';
import assert from 'node:assert/strict';
import { CmdlessUI, getPackageName } from './utils.js';

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

test('CmdlessUI.toArgs builds show argv with only the provided options', () => {
  const args = CmdlessUI.toArgs({
    kind: 'show',
    type: 'url',
    source: 'https://example.com',
    app: 'agent-picker',
  });
  assert.deepEqual(args, ['show', 'url', 'https://example.com', '--app', 'agent-picker']);
});

test('CmdlessUI.toArgs omits options that were not provided', () => {
  const args = CmdlessUI.toArgs({
    kind: 'show',
    type: 'file',
    source: '/tmp/index.html',
  });
  assert.deepEqual(args, ['show', 'file', '/tmp/index.html']);
});

test('CmdlessUI.toArgs builds message-box argv', () => {
  const args = CmdlessUI.toArgs({
    kind: 'message-box',
    type: 'warning',
    message: 'are you sure?',
  });
  assert.deepEqual(args, ['message-box', 'warning', 'are you sure?']);
});
