import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { codexTrustedProjects, trustedPath } from './trust.js';

test('trustedPath expands ~, drops trailing slashes and refuses relative paths', () => {
  assert.equal(trustedPath('~/code/'), path.join(os.homedir(), 'code'));
  assert.equal(trustedPath('/tmp/a/../b/'), '/tmp/b');
  assert.throws(() => trustedPath('code'), /absolute/);
});

test('codexTrustedProjects reads the trusted projects from CODEX_HOME', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'codex-'));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    assert.deepEqual(await codexTrustedProjects(), []);
    await writeFile(path.join(home, 'config.toml'), [
      'model = "gpt-5"',
      '[projects."/work/a"]',
      'trust_level = "trusted"',
      '',
      '[projects."/work/b"]',
      'trust_level = "untrusted"',
      "[projects.'/work/c \"quoted\"']",
      'trust_level = "trusted" # literal key',
      '[projects."/work/d"]',
      '[mcp_servers.x]',
      'trust_level = "trusted"',
    ].join('\n'));
    assert.deepEqual(await codexTrustedProjects(), ['/work/a', '/work/c "quoted"']);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    await rm(home, { recursive: true });
  }
});
