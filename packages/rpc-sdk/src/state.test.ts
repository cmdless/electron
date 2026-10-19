import test from 'node:test';
import assert from 'node:assert/strict';
import jsonpatch from 'fast-json-patch';
import { defineProtocol } from './protocol.js';
import type { StatePatch } from './state.js';

type Agents = { entries: Record<string, { name: string }> };

const protocol = defineProtocol(({ state }) => ({
  state: {
    agents: state<Agents>('agents'),
    count: state<number>('count'),
  },
}));

const createStore = () => protocol.createStore(async () => ({ agents: { entries: {} }, count: 0 }));

test('createStore starts from what init resolves, at seq 0', async () => {
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
