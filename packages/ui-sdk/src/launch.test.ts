import test from 'node:test';
import assert from 'node:assert/strict';
import { commandNames, commandsFor, parseLaunch, repoKey, sourceKey, validLaunch } from './launch.js';

const app = { type: 'npm', package: '@x/app' };

test('a launch is its sources and commands that use them, checked', () => {
  assert.deepEqual(parseLaunch(JSON.stringify({ name: ' x ', sources: { app }, commands: [{ source: 'app' }] })),
    { name: 'x', sources: { app: { type: 'npm', package: '@x/app' } }, commands: [{ source: 'app', args: [] }] });
  assert.throws(() => parseLaunch('nope'), /isn't JSON/);
  assert.throws(() => validLaunch({ name: 'x', sources: { app }, commands: [] }), /no commands/);
  assert.throws(() => validLaunch({ name: 'x', sources: { app }, commands: [{ source: 'other' }] }), /isn't in sources/);
  assert.throws(() => validLaunch({ name: 'x', sources: { app, spare: app }, commands: [{ source: 'app' }] }), /no command uses source spare/);
  assert.throws(() => validLaunch({ name: 'x', sources: { app: { type: 'ftp' } }, commands: [{ source: 'app' }] }), /npm, git or local/);
  assert.throws(() => validLaunch({ name: 'x', sources: { app: { type: 'git' } }, commands: [{ source: 'app' }] }), /repo is missing/);
  assert.throws(() => validLaunch({ name: 'x', sources: { app }, commands: [{ source: 'app', args: [1] }] }), /aren't all strings/);
});

test('named command lists are choices, and one is needed', () => {
  const launch = validLaunch({ name: 'x', sources: { app }, commands: { prod: [{ source: 'app' }], dev: [{ source: 'app', args: ['--dev'] }] } });
  assert.deepEqual(commandNames(launch), ['prod', 'dev']);
  assert.deepEqual(commandsFor(launch, 'dev'), [{ source: 'app', args: ['--dev'] }]);
  assert.throws(() => commandsFor(launch), /needs one of prod, dev/);
  assert.throws(() => commandsFor(launch, 'qa'), /no commands qa/);
  const single = validLaunch({ name: 'y', sources: { app }, commands: [{ source: 'app' }] });
  assert.equal(commandNames(single), undefined);
  assert.throws(() => commandsFor(single, 'prod'), /no named commands/);
});

test('trust is the package, the repo however it\'s written, or the folder', () => {
  for (const repo of ['github:Owner/Repo', 'owner/repo', 'https://github.com/owner/repo.git', 'git+https://github.com/owner/repo', 'git@github.com:owner/repo.git', 'github:owner/repo#dev'])
    assert.equal(repoKey(repo), 'github:owner/repo', repo);
  assert.equal(sourceKey({ type: 'npm', package: '@x/app', version: '1.0.0' }), 'npm:@x/app');
  assert.equal(sourceKey({ type: 'git', repo: 'owner/repo', ref: 'v2' }), 'git:github:owner/repo');
  assert.equal(sourceKey({ type: 'local', path: '/a/b' }), 'local:/a/b');
});
