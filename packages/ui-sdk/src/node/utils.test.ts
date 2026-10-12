import test from 'node:test';
import assert from 'node:assert/strict';
import { CmdlessUI, CmdlessEnv, createShowCommand, getPackageName } from './utils.js';
import type * as types from '../types.js';

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

test('createShowCommand: a dev CMDLESS_URL override preserves the original source\'s hash route', async () => {
  let seen: types.ShowParams | undefined;
  const dispatcher = async (parameters: types.Params) => {
    seen = parameters as types.ShowParams;
    return 'ok';
  };

  const show = createShowCommand({
    params: () => ({ type: 'file', source: '/dist/index.html#/pick-agent' }),
    dispatcher,
  });

  const originalUrl = CmdlessEnv.url;
  CmdlessEnv.url = 'http://localhost:5173/';
  try {
    await show();
  } finally {
    CmdlessEnv.url = originalUrl;
  }

  assert.equal(seen?.type, 'url');
  assert.equal(seen?.source, 'http://localhost:5173/#/pick-agent');
});

test('createShowCommand: a dev CMDLESS_URL override with no hash in the original source is used as-is', async () => {
  let seen: types.ShowParams | undefined;
  const dispatcher = async (parameters: types.Params) => {
    seen = parameters as types.ShowParams;
    return 'ok';
  };

  const show = createShowCommand({
    params: () => ({ type: 'file', source: '/dist/index.html' }),
    dispatcher,
  });

  const originalUrl = CmdlessEnv.url;
  CmdlessEnv.url = 'http://localhost:5173/';
  try {
    await show();
  } finally {
    CmdlessEnv.url = originalUrl;
  }

  assert.equal(seen?.source, 'http://localhost:5173/');
});
