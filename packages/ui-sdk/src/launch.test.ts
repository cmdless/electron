import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLaunch, sameLaunch, validLaunch } from './launch.js';

test('a launch is a name and its commands, checked', () => {
  assert.deepEqual(parseLaunch('{ "name": " x ", "commands": [{ "command": "npx" }] }'), { name: 'x', commands: [{ command: 'npx', args: [] }] });
  assert.throws(() => parseLaunch('nope'), /isn't JSON/);
  assert.throws(() => validLaunch({ name: 'x', commands: [] }), /no commands/);
  assert.throws(() => validLaunch({ commands: [{ command: 'a' }] }), /no name/);
  assert.throws(() => validLaunch({ name: 'x', commands: [{ command: 'a', args: [1] }] }), /aren't all strings/);
});

test('the same launch is the same name running the same commands', () => {
  const a = validLaunch({ name: 'x', commands: [{ command: 'npx', args: ['a'] }] });
  assert.equal(sameLaunch(a, validLaunch({ name: 'x', commands: [{ command: 'npx', args: ['a'] }] })), true);
  assert.equal(sameLaunch(a, validLaunch({ name: 'x', commands: [{ command: 'npx', args: ['b'] }] })), false);
  assert.equal(sameLaunch(a, validLaunch({ name: 'y', commands: [{ command: 'npx', args: ['a'] }] })), false);
});
