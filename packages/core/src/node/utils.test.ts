import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { getTmpSocketPath, listenExclusive, resolveService, waitForService } from './utils.js';

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
