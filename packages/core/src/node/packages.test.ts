import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compareVersions, execProcess, findLocalBinPath, getInstallPath, getPackageName, newestCachedVersion } from './packages.js';

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

test('compareVersions orders releases numerically, a prerelease before its release', () => {
  const sorted = ['0.0.10', '0.0.9', '1.0.0', '1.0.0-beta.2', '0.10.0', '1.0.0-beta.10', '0.0.9'].sort(compareVersions);
  assert.deepEqual(sorted, ['0.0.9', '0.0.9', '0.0.10', '0.10.0', '1.0.0-beta.2', '1.0.0-beta.10', '1.0.0']);
});

test('newestCachedVersion picks the newest installed version, ignoring half-made ones', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmdless-newest-'));
  try {
    const install = (version: string, whole = true) => {
      const dir = path.join(getInstallPath(root), '@x/pkg', version, 'node_modules', '@x/pkg');
      fs.mkdirSync(dir, { recursive: true });
      if (whole) fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    };
    assert.equal(newestCachedVersion('@x/pkg', root), undefined);
    install('0.0.9');
    install('0.0.10');
    install('0.1.0', false);
    assert.equal(newestCachedVersion('@x/pkg', root), '0.0.10');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a package meta can\'t see has no local bin, rather than a throw', () => {
  assert.equal(findLocalBinPath('@cmdless/not-a-package', import.meta), null);
});
