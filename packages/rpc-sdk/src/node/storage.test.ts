import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { file } from './storage.js';

const tempFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rpc-sdk-storage-')), 'nested', 'state.json');

test('file writes its default when there is no file yet', async () => {
  const filePath = tempFile();
  const storage = file(filePath, { default: { a: 1 } });
  assert.deepEqual(await storage.load(), { a: 1 });
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), { a: 1 });
});

test('file loads what is there, and saves over it', async () => {
  const filePath = tempFile();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ a: 2 }));
  const storage = file(filePath, { default: { a: 1 } });

  assert.deepEqual(await storage.load(), { a: 2 });
  await storage.save!({ state: { a: 3 }, previous: { a: 2 }, ops: [] });
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), { a: 3 });
  assert.deepEqual(fs.readdirSync(path.dirname(filePath)), ['state.json']);
});

test('file refuses to load a file that is not JSON', async () => {
  const filePath = tempFile();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '{ nope');
  await assert.rejects(async () => file(filePath, { default: {} }).load(), /isn't valid JSON/);
  assert.equal(fs.readFileSync(filePath, 'utf8'), '{ nope');
});
