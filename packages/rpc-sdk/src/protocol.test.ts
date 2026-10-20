import test from 'node:test';
import assert from 'node:assert/strict';
import { defineProtocol } from './protocol.js';
import { memory } from './state.js';
import type { StateValues } from './protocol.js';
import { createLoopbackPair, tick } from './loopback.fixture.js';



test('a request round-trips with the correct params and result types', async () => {
  const protocol = defineProtocol(({ side, request }) => ({
    clientToServer: side({
      requests: { ping: request<{ text: string }, { text: string }>('ping') },
    }),
  }));

  const { clientConn, serverConn } = createLoopbackPair();
  const client = protocol.createClient(clientConn);
  const server = protocol.createServer(serverConn);

  server.onRequest.ping(async ({ text }) => ({ text: text.toUpperCase() }));
  client.listen();
  server.listen();

  const result = await client.request.ping({ text: 'hello' });
  assert.deepEqual(result, { text: 'HELLO' });
});

test('a notification flows from client to server', async () => {
  const protocol = defineProtocol(({ side, notification }) => ({
    clientToServer: side({
      notifications: { ping: notification<{ n: number }>('ping') },
    }),
  }));

  const { clientConn, serverConn } = createLoopbackPair();
  const client = protocol.createClient(clientConn);
  const server = protocol.createServer(serverConn);

  const received: number[] = [];
  server.onNotification.ping(({ n }) => { received.push(n); });
  client.listen();
  server.listen();

  client.notify.ping({ n: 1 });
  await tick();

  assert.deepEqual(received, [1]);
});

test('disposing a notification handler stops it from firing', async () => {
  const protocol = defineProtocol(({ side, notification }) => ({
    clientToServer: side({
      notifications: { ping: notification<{ n: number }>('ping') },
    }),
  }));

  const { clientConn, serverConn } = createLoopbackPair();
  const client = protocol.createClient(clientConn);
  const server = protocol.createServer(serverConn);

  const received: number[] = [];
  const disposable = server.onNotification.ping(({ n }) => { received.push(n); });
  client.listen();
  server.listen();

  client.notify.ping({ n: 1 });
  await tick();
  disposable.dispose();

  client.notify.ping({ n: 2 });
  await tick();

  assert.deepEqual(received, [1]);
});

test('state channels are declared beside the sides and keep their value types', () => {
  type Agents = { entries: Record<string, { name: string }> };
  const protocol = defineProtocol(({ side, request, state }) => ({
    clientToServer: side({
      requests: { addAgent: request<{ id: string }, void>('agents/add') },
    }),
    state: {
      agents: state<Agents>('agents'),
      count: state<number>('count'),
    },
  }));

  assert.deepEqual(protocol.state, { agents: { name: 'agents' }, count: { name: 'count' } });

  type Values = StateValues<typeof protocol.state>;
  const values: Values = { agents: { entries: { a: { name: 'A' } } }, count: 1 };
  // @ts-expect-error - count is a number
  const wrong: Values = { agents: { entries: {} }, count: 'one' };
  void values; void wrong;
});

test('a protocol without state channels has an empty state', () => {
  const protocol = defineProtocol(({ side, request }) => ({
    clientToServer: side({ requests: { ping: request('ping') } }),
  }));
  assert.deepEqual(protocol.state, {});
  const empty: {} = protocol.state;
  void empty;
});

test('defineHost configures every connection it accepts the same way', async () => {
  const protocol = defineProtocol(({ side, request }) => ({
    clientToServer: side({
      requests: { ping: request<{ text: string }, string>('ping') },
    }),
  }));

  let configured = 0;
  const createPingHost = protocol.defineHost({
    configure: (server, store) => {
      configured++;
      assert.equal(store, undefined);
      server.onRequest.ping(({ text }) => `pong ${text}`);
    },
  });
  const { store, accept } = await createPingHost();
  assert.equal(store, undefined);

  for (const text of ['a', 'b']) {
    const { clientConn, serverConn } = createLoopbackPair();
    const server = accept(serverConn);
    const client = protocol.createClient(clientConn);
    server.listen();
    client.listen();
    assert.equal(await client.request.ping({ text }), `pong ${text}`);
    assert.deepEqual(server.state, {});
  }

  assert.equal(configured, 2);
});

test('defineHost creates a store from state and shares it with every connection', async () => {
  const protocol = defineProtocol(({ side, request, state }) => ({
    clientToServer: side({
      requests: { increment: request<void, number>('increment') },
    }),
    state: { count: state<number>('count') },
  }));

  const createCounterHost = protocol.defineHost({
    state: { count: memory(0) },
    configure: (server, store) => {
      server.onRequest.increment(() => {
        store.update('count', count => count + 1);
        return store.state.count;
      });
    },
  });
  const { store, accept } = await createCounterHost();

  for (const expected of [1, 2]) {
    const { clientConn, serverConn } = createLoopbackPair();
    const server = accept(serverConn);
    const client = protocol.createClient(clientConn);
    server.listen();
    client.listen();
    assert.equal(await client.request.increment(), expected);
  }
  assert.equal(store.state.count, 2);

  // each call of the factory is its own host, with its own store
  const other = await createCounterHost();
  assert.equal(other.store.state.count, 0);

  // @ts-expect-error - a protocol with state channels needs its initial state
  protocol.defineHost({});
});

test('createServer takes the store directly, for when there is no host', async () => {
  const protocol = defineProtocol(({ state }) => ({
    state: { count: state<number>('count') },
  }));
  const store = await protocol.createStore({ count: memory(0) });
  const { serverConn } = createLoopbackPair();

  const server = protocol.createServer(serverConn, store);
  server.state.set({ count: 3 });
  assert.equal(store.state.count, 3);

  // @ts-expect-error - a protocol with state channels needs a store
  protocol.createServer(serverConn);
});

test('onClose runs once when either side ends the connection', async () => {
  const protocol = defineProtocol(({ side, request }) => ({
    clientToServer: side({ requests: { ping: request('ping') } }),
  }));
  const { clientConn, serverConn } = createLoopbackPair();
  const server = protocol.createServer(serverConn);
  const client = protocol.createClient(clientConn);
  server.listen();
  client.listen();

  let closed = 0;
  server.onClose(() => closed++);
  server.dispose();
  server.dispose();
  assert.equal(closed, 1);
});
