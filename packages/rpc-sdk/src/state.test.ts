import test from 'node:test';
import assert from 'node:assert/strict';
import jsonpatch from 'fast-json-patch';
import { defineProtocol } from './protocol.js';
import { memory } from './state.js';
import type { ChannelStorage, StateChange, StatePatch } from './state.js';
import { createLoopbackPair, tick } from './loopback.fixture.js';

type Agents = { entries: Record<string, { name: string }> };

const protocol = defineProtocol(({ state }) => ({
  state: {
    agents: state<Agents>('agents'),
    count: state<number>('count'),
  },
}));

const initial = () => ({ agents: memory<Agents>({ entries: {} }), count: memory(0) });
const createStore = () => protocol.createStore(initial());

test('createStore starts from what each channel loads, at seq 0', async () => {
  const store = await createStore();
  assert.deepEqual(store.state, { agents: { entries: {} }, count: 0 });
  assert.equal(store.seq('agents'), 0);
});

test('set replaces a channel and sends its watchers the patch', async () => {
  const store = await createStore();
  const patches: StatePatch[] = [];
  const watch = store.watch('agents', patch => patches.push(patch));

  store.set({ agents: { entries: { a: { name: 'A' } } } });

  assert.equal(store.seq('agents'), 1);
  assert.deepEqual(patches, [{ seq: 1, ops: [{ op: 'add', path: '/entries/a', value: { name: 'A' } }] }]);
  // the watcher can rebuild the state from where it started
  const rebuilt = jsonpatch.applyPatch(watch.state, patches[0].ops, false, false).newDocument;
  assert.deepEqual(rebuilt, store.state.agents);
});

test('set leaves channels it was not given alone', async () => {
  const store = await createStore();
  const patches: StatePatch[] = [];
  store.watch('count', patch => patches.push(patch));

  store.set({ agents: { entries: { a: { name: 'A' } } } });

  assert.equal(store.seq('count'), 0);
  assert.deepEqual(patches, []);
});

test('a set that changes nothing sends nothing and keeps the seq', async () => {
  const store = await createStore();
  const patches: StatePatch[] = [];
  store.watch('agents', patch => patches.push(patch));

  store.set({ agents: { entries: {} } });

  assert.equal(store.seq('agents'), 0);
  assert.deepEqual(patches, []);
});

test('update edits a draft in place', async () => {
  const store = await createStore();
  store.update('agents', draft => { draft.entries.b = { name: 'B' }; });
  assert.deepEqual(store.state.agents, { entries: { b: { name: 'B' } } });
});

test('update can return a replacement instead', async () => {
  const store = await createStore();
  store.update('count', count => count + 1);
  assert.equal(store.state.count, 1);
});

test('a primitive channel is replaced whole', async () => {
  const store = await createStore();
  const patches: StatePatch[] = [];
  store.watch('count', patch => patches.push(patch));

  store.set({ count: 5 });
  assert.deepEqual(patches, [{ seq: 1, ops: [{ op: 'replace', path: '', value: 5 }] }]);
});

test('mutating a value after set does not change the store', async () => {
  const store = await createStore();
  const agents: Agents = { entries: {} };
  store.set({ agents });
  agents.entries.sneaky = { name: 'S' };
  assert.deepEqual(store.state.agents, { entries: {} });
});

test('a disposed watch gets no more patches', async () => {
  const store = await createStore();
  const patches: StatePatch[] = [];
  store.watch('count', patch => patches.push(patch)).dispose();
  store.set({ count: 1 });
  assert.deepEqual(patches, []);
});

test('an unknown channel throws', async () => {
  const store = await createStore();
  // @ts-expect-error - not a channel of this protocol
  assert.throws(() => store.set({ nope: 1 }), /unknown state channel: nope/);
});

// a storage that records its saves, and holds each one open until released
function recording<T>(initial: T) {
  const saves: StateChange<T>[] = [];
  const pending: (() => void)[] = [];
  const storage: ChannelStorage<T> = {
    load: () => initial,
    save: change => new Promise<void>(resolve => { saves.push(change); pending.push(resolve); }),
  };
  const release = () => pending.splice(0).forEach(resolve => resolve());
  return { storage, saves, release };
}

test('a channel with storage saves every change, and set settles once it has', async () => {
  const count = recording(0);
  const store = await protocol.createStore({ agents: memory<Agents>({ entries: {} }), count: count.storage });

  let settled = false;
  const saved = store.set({ count: 1 }).then(() => { settled = true; });
  await tick();
  assert.deepEqual(count.saves, [{ state: 1, previous: 0, ops: [{ op: 'replace', path: '', value: 1 }] }]);
  assert.equal(settled, false);

  count.release();
  await saved;
  assert.equal(settled, true);
});

test('changes during a save fold into one save of the latest state', async () => {
  const count = recording(0);
  const store = await protocol.createStore({ agents: memory<Agents>({ entries: {} }), count: count.storage });

  const first = store.set({ count: 1 });
  await tick();
  const second = store.set({ count: 2 });
  const third = store.set({ count: 3 });
  assert.equal(count.saves.length, 1);

  count.release();
  await first;
  await tick();
  assert.equal(count.saves.length, 2);
  assert.deepEqual(count.saves[1].state, 3);
  assert.deepEqual(count.saves[1].previous, 1);
  assert.equal(count.saves[1].ops.length, 2);

  count.release();
  await Promise.all([second, third]);
});

test('a failed save rejects set, and leaves the change applied', async () => {
  const store = await protocol.createStore({
    agents: memory<Agents>({ entries: {} }),
    count: { load: () => 0, save: () => { throw new Error('disk full'); } },
  });
  await assert.rejects(store.set({ count: 1 }), /disk full/);
  assert.equal(store.state.count, 1);
});

test('memory starts each store from its own copy', async () => {
  const shared = memory<Agents>({ entries: {} });
  const one = await protocol.createStore({ agents: shared, count: memory(0) });
  const two = await protocol.createStore({ agents: shared, count: memory(0) });
  await one.update('agents', draft => { draft.entries.a = { name: 'A' }; });
  assert.deepEqual(two.state.agents, { entries: {} });
});

// over a real (in-memory) connection: a host serving the store, and clients
// mirroring it through subscribe

async function createServing() {
  const { store, accept } = await protocol.defineHost({ state: initial() })();

  // counts the watches connections hold, to see subscriptions come and go
  let watching = 0;
  let watched = 0;
  const watch = store.watch;
  store.watch = (channel, listener) => {
    watching++;
    watched++;
    const result = watch(channel, listener);
    return { ...result, dispose: () => { watching--; result.dispose(); } };
  };

  const connect = () => {
    const { clientConn, serverConn } = createLoopbackPair();
    accept(serverConn).listen();
    const client = protocol.createClient(clientConn);
    client.listen();
    return { client, clientConn, serverConn };
  };
  return { store, connect, watches: () => ({ watching, watched }) };
}

async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await tick();
  assert.ok(check(), 'timed out waiting');
}

test('subscribe gets the current state, then every change', async () => {
  const { store, connect } = await createServing();
  store.set({ agents: { entries: { a: { name: 'A' } } } });
  const { client } = connect();

  const seen: Agents[] = [];
  await client.state.agents.subscribe(state => seen.push(state));
  assert.deepEqual(seen, [{ entries: { a: { name: 'A' } } }]);

  store.update('agents', draft => { draft.entries.b = { name: 'B' }; });
  store.update('agents', draft => { delete draft.entries.a; });
  await until(() => seen.length === 3);

  assert.deepEqual(seen[2], { entries: { b: { name: 'B' } } });
  assert.deepEqual(client.state.agents.current, store.state.agents);
});

test('a primitive channel mirrors too', async () => {
  const { store, connect } = await createServing();
  const { client } = connect();
  await client.state.count.subscribe(() => { });
  store.set({ count: 7 });
  await until(() => client.state.count.current === 7);
});

test('listeners on one connection share a single subscription', async () => {
  const { store, connect, watches } = await createServing();
  const { client } = connect();

  const first: number[] = [];
  const second: number[] = [];
  const stopFirst = await client.state.count.subscribe(count => first.push(count));
  const stopSecond = await client.state.count.subscribe(count => second.push(count));
  assert.deepEqual(watches(), { watching: 1, watched: 1 });

  store.set({ count: 1 });
  await until(() => first.length === 2 && second.length === 2);
  assert.deepEqual([first, second], [[0, 1], [0, 1]]);

  stopFirst();
  await tick();
  assert.equal(watches().watching, 1);

  stopSecond();
  await until(() => watches().watching === 0);
  assert.equal(client.state.count.current, undefined);

  store.set({ count: 2 });
  await tick();
  assert.deepEqual(second, [0, 1]);
});

test('each connection gets its own patches', async () => {
  const { store, connect } = await createServing();
  const one = connect().client;
  const two = connect().client;
  await one.state.count.subscribe(() => { });
  await two.state.count.subscribe(() => { });

  store.set({ count: 3 });
  await until(() => one.state.count.current === 3 && two.state.count.current === 3);
});

test('a gap in seq resubscribes for a fresh state', async () => {
  const { store, connect, watches } = await createServing();
  const { client, serverConn } = connect();
  await client.state.count.subscribe(() => { });

  // the store moves on while a patch goes missing on the way
  store.set({ count: 4 });
  await until(() => client.state.count.current === 4);
  store.set({ count: 5 });
  await serverConn.sendNotification('$/state/patch', { channel: 'count', seq: store.seq('count') + 3, ops: [] });

  await until(() => watches().watched === 2);
  await until(() => client.state.count.current === 5);
  assert.equal(watches().watching, 1);
});

test('a closed connection drops its subscriptions', async () => {
  const { connect, watches } = await createServing();
  const { client, serverConn } = connect();
  await client.state.agents.subscribe(() => { });
  await client.state.count.subscribe(() => { });
  assert.equal(watches().watching, 2);

  serverConn.dispose();
  assert.equal(watches().watching, 0);
});
