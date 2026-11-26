import test from 'node:test';
import assert from 'node:assert/strict';
import { chunked, pipeConnection } from './pipes.js';
import type { Pipe } from './pipes.js';

// two ends of an in-memory pipe, recording what crosses it
function pipePair() {
  const crossed: string[] = [];
  const make = (): Pipe & { deliver: (text: string) => void; listeners: ((text: string) => void)[]; closes: (() => void)[] } => {
    const end = {
      listeners: [] as ((text: string) => void)[],
      closes: [] as (() => void)[],
      deliver: (text: string) => end.listeners.forEach(listener => listener(text)),
      send: (_: string) => { },
      onMessage: (listener: (text: string) => void) => { end.listeners.push(listener); },
      onClose: (listener: () => void) => { end.closes.push(listener); },
      close: () => { a.closes.forEach(close => close()); b.closes.forEach(close => close()); },
    };
    return end;
  };
  const a = make();
  const b = make();
  a.send = text => { crossed.push(text); b.deliver(text); };
  b.send = text => { crossed.push(text); a.deliver(text); };
  return { a, b, crossed };
}

test('a small message crosses as one part', () => {
  const { a, b, crossed } = pipePair();
  const received: string[] = [];
  chunked(b).onMessage(text => received.push(text));
  chunked(a).send('hello');
  assert.deepEqual(crossed, ['ehello']);
  assert.deepEqual(received, ['hello']);
});

test('a big message is split into parts and put back together', () => {
  const { a, b, crossed } = pipePair();
  const received: string[] = [];
  chunked(b).onMessage(text => received.push(text));
  const big = 'x'.repeat(40_000) + 'é' + 'y'.repeat(10);
  chunked(a).send(big);
  assert.equal(crossed.length, 3);
  assert.ok(crossed.every(part => part.length <= 16_001));
  assert.deepEqual(received, [big]);
});

test('an empty message still crosses', () => {
  const { a, b } = pipePair();
  const received: string[] = [];
  chunked(b).onMessage(text => received.push(text));
  chunked(a).send('');
  assert.deepEqual(received, ['']);
});

test('pipeConnection carries JSON-RPC both ways and ends when the pipe closes', async () => {
  const { a, b } = pipePair();
  const client = pipeConnection(chunked(a));
  const server = pipeConnection(chunked(b));
  server.onRequest('echo', (params: { text: string }) => params.text.toUpperCase());
  server.listen();
  client.listen();
  assert.equal(await client.sendRequest('echo', { text: 'z'.repeat(50_000) }), 'Z'.repeat(50_000));

  let closed = false;
  server.onDispose(() => { closed = true; });
  a.close();
  assert.equal(closed, true);
});
