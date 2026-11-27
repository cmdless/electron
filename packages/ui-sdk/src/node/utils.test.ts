import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { getCmdlessApp, getEphemeralPrefix, isEphemeralCmdlessApp, isEphemeralUserData, setCmdlessApp } from './utils.js';

test('isEphemeralUserData only accepts an ephemeral app\'s directory inside the ephemeral folder', () => {
  const id = '1b85461e-34c0-4186-91c6-f8f134158e2e';
  const root = path.join(os.tmpdir(), getEphemeralPrefix());
  assert.equal(isEphemeralUserData(path.join(root, id)), true);
  assert.equal(isEphemeralUserData(path.join('/anywhere/else', getEphemeralPrefix(), id)), true);
  assert.equal(isEphemeralUserData(path.join(os.tmpdir(), id)), false);
  assert.equal(isEphemeralUserData(path.join(root, 'not-an-id')), false);
  assert.equal(isEphemeralUserData(path.join(root, id, '..')), false);
  assert.equal(isEphemeralUserData(path.join(root, id, 'nested')), false);
  assert.equal(isEphemeralUserData(path.join('.cmdless.ui', id)), false);
});

test('an app name from the env is a named app\'s or a throwaway one\'s, and nothing else', () => {
  const id = '1b85461e-34c0-4186-91c6-f8f134158e2e';
  assert.equal(isEphemeralCmdlessApp(`${getEphemeralPrefix()}${id}`), true);
  for (const name of [`${getEphemeralPrefix()}../../x`, `${getEphemeralPrefix()}${id}/..`, getEphemeralPrefix()])
    assert.equal(isEphemeralCmdlessApp(name), false, name);

  const env: NodeJS.ProcessEnv = {};
  setCmdlessApp('@cmdless/gh-approvals', env);
  assert.equal(env.CMDLESS_APP, '@cmdless/gh-approvals');
  setCmdlessApp(`${getEphemeralPrefix()}${id}`, env);
  assert.equal(env.CMDLESS_APP, `${getEphemeralPrefix()}${id}`);
  for (const name of ['../../x', `${getEphemeralPrefix()}../../x`, 'Hangar'])
    assert.throws(() => setCmdlessApp(name, env), /isn't an app name/, name);

  const before = process.env.CMDLESS_APP;
  try {
    process.env.CMDLESS_APP = '../../escape';
    assert.throws(() => getCmdlessApp(), /isn't an app name/);
  } finally {
    if (before === undefined) delete process.env.CMDLESS_APP;
    else process.env.CMDLESS_APP = before;
  }
});
