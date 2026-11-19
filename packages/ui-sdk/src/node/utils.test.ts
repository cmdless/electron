import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { getEphemeralPrefix, isEphemeralUserData } from './utils.js';

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
