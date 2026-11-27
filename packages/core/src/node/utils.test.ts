import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { acquireLock, getAppDataPath, getCmdlessRoot, getTmpSocketPath, listenExclusive, listenOnce, resolveService, sendTo, validCmdlessAppName, waitForService } from './utils.js';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'service.fixture.ts');
const run = (...args: string[]): [string, string[]] => [process.execPath, ['--import', 'tsx', fixture, ...args]];

test('waitForService resolves with the value the child reports, leaving it running', async () => {
  const { child, value } = await waitForService<{ pid: number; args: string[] }>(...run('resolve', 'a', 'b'));
  try {
    assert.equal(value.pid, child.pid);
    assert.deepEqual(value.args, ['a', 'b']);
    assert.equal(child.exitCode, null);
  } finally {
    child.kill();
  }
});

test('waitForService rejects with the error the child reports', async () => {
  await assert.rejects(waitForService(...run('reject')), /could not start/);
});

test('waitForService rejects when the child exits before reporting', async () => {
  await assert.rejects(waitForService(...run('exit')), /exited \(3\) before resolving/);
});

test('waitForService rejects on timeout and kills the child', async () => {
  await assert.rejects(waitForService(...run('silent'), { timeoutMs: 1 }), /did not resolve as a service within 1ms/);
});

test('resolveService throws outside of waitForService', () => {
  assert.throws(() => resolveService(1), /was this process started by waitForService/);
});

test('listenExclusive lets only one server hold a socket', async () => {
  const socketPath = getTmpSocketPath(`cmdless-test-${crypto.randomUUID()}`);
  const first = net.createServer();
  const second = net.createServer();
  try {
    assert.equal(await listenExclusive(first, socketPath), true);
    assert.equal(await listenExclusive(second, socketPath), false);
    if (process.platform !== 'win32')
      assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600);
  } finally {
    first.close();
    second.close();
  }
});

test('listenExclusive replaces a socket nothing listens on', { skip: process.platform === 'win32' }, async () => {
  const socketPath = getTmpSocketPath(`cmdless-test-${crypto.randomUUID()}`);
  // a process that listens and is then killed outright leaves its socket file behind
  const holder = spawn(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(socketPath)}, () => console.log('up'))`]);
  await new Promise(resolve => holder.stdout.once('data', resolve));
  holder.kill('SIGKILL');
  await new Promise(resolve => holder.once('exit', resolve));
  assert.ok(fs.existsSync(socketPath));

  const server = net.createServer();
  try {
    assert.equal(await listenExclusive(server, socketPath), true);
  } finally {
    server.close();
  }
});

test('listenOnce resolves with the first message sent to it, then stops listening', async () => {
  const once = await listenOnce<{ address: string }>();
  await sendTo(once.socketPath, { type: 'resolve', value: { address: 'here' } });
  assert.deepEqual(await once.message, { address: 'here' });
  await new Promise(resolve => setTimeout(resolve, 10));
  await assert.rejects(sendTo(once.socketPath, { type: 'resolve', value: { address: 'again' } }));
});

test('listenOnce rejects with a reject message, a hang-up, or the timeout', async () => {
  const rejected = await listenOnce();
  await sendTo(rejected.socketPath, { type: 'reject', error: 'no lock' });
  await assert.rejects(rejected.message, /no lock/);

  const hungUp = await listenOnce();
  await new Promise<void>(resolve => { const socket = net.createConnection(hungUp.socketPath, () => { socket.end(); resolve(); }); });
  await assert.rejects(hungUp.message, /hung up/);

  await assert.rejects((await listenOnce(1)).message, /nothing arrived within 1ms/);
});

test('an app name is a package name\'s shape, and nothing that leaves its folder', () => {
  for (const name of ['hangar', 'cmdless-auth', '@cmdless/gh-approvals', 'a.b_c~d-e', '0app'])
    assert.equal(validCmdlessAppName(name), name);
  for (const name of ['', '..', '.', '../x', 'a/../b', '@cmdless/../x', '@scope/', '@/x', 'a/b', 'a\\b', '/abs', 'C:\\x',
    '.hidden', '-flag', 'Upper', 'a b', '@a/b/c', 'x'.repeat(215)])
    assert.throws(() => validCmdlessAppName(name), /isn't an app name/, name);
  assert.equal(path.relative(getCmdlessRoot(), getAppDataPath('@cmdless/gh-approvals')), path.join('apps', '@cmdless', 'gh-approvals'));
  assert.throws(() => getAppDataPath('../../etc'), /isn't an app name/);
});

test('acquireLock holds one at a time, and the next gets it once it\'s let go', async () => {
  const name = `cmdless-lock-test-${process.pid}`;
  const order: string[] = [];
  const release = await acquireLock(name);
  const second = acquireLock(name).then(release => { order.push('second'); return release; });
  await new Promise(resolve => setTimeout(resolve, 50));
  order.push('first done');
  await release();
  await (await second)();
  assert.deepEqual(order, ['first done', 'second']);
});
