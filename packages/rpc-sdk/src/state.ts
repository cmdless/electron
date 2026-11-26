import jsonpatch from 'fast-json-patch';
import type { Operation } from 'fast-json-patch';
import { NotificationType, RequestType } from 'vscode-jsonrpc';
import type { MessageConnection } from 'vscode-jsonrpc';
import type { MaybePromise } from './shared.js';
import type { RpcStates, StateValues } from './protocol.js';

export type { Operation } from 'fast-json-patch';

// one change to one channel: the JSON Patch that takes its state from
// seq - 1 to seq
export type StatePatch = { seq: number; ops: Operation[] };

export type StateWatch<T> = {
  // the channel's state and seq at the moment of watching - every patch
  // the listener gets after this has a higher seq
  state: T;
  seq: number;
  dispose: () => void;
};

export type RpcStore<S extends Record<string, unknown>> = {
  readonly state: Readonly<S>;
  seq: (channel: keyof S) => number;
  // replaces each given channel whole, like a shallow setState - a channel
  // left out is untouched, and a deep edit goes through update instead.
  // The change applies (and reaches subscribers) at once; what's returned
  // settles once every changed channel's storage has saved it.
  set: (partial: Partial<S>) => Promise<void>;
  // edits a copy of one channel's state; the draft is changed in place, or
  // a returned value replaces it
  update: <K extends keyof S>(channel: K, edit: (draft: S[K]) => S[K] | void) => Promise<void>;
  // applies a JSON Patch to one channel as it is, and sends those same ops
  // on - for passing on another channel's changes without diffing again.
  // Ops that don't apply throw, and leave the state as it was.
  patch: <K extends keyof S>(channel: K, ops: Operation[]) => Promise<void>;
  // what a connection's subscription hangs off: the state to start from,
  // and every patch after it
  watch: <K extends keyof S>(channel: K, listener: (patch: StatePatch) => void) => StateWatch<S[K]>;
};

// one change to a channel, as its storage sees it
export type StateChange<T> = {
  state: T;
  previous: T;
  ops: Operation[];
};

// where a channel's state comes from and goes to: load gives the state the
// store starts from, and save (when there is one) is handed every change
// (methods, not function properties, so a storage built from a narrower
// literal - memory({ status: 'starting' }) - still fits its channel's type)
export type ChannelStorage<T> = {
  load(): MaybePromise<T>;
  save?(change: StateChange<T>): MaybePromise<void>;
};

// a channel's storage for each of a protocol's state channels
export type StoreStorage<S extends Record<string, unknown>> = { [K in keyof S]: ChannelStorage<S[K]> };

// state that only lives as long as the store: starts as initial, saves nothing
export function memory<T>(initial: T): ChannelStorage<T> {
  return { load: () => structuredClone(initial) };
}

const isContainer = (value: unknown) => typeof value === 'object' && value !== null;

// compare only diffs objects and arrays - anything else (a number, a string,
// null, or a change between those and a container) replaces the whole value
function diff(prev: unknown, next: unknown): Operation[] {
  if (isContainer(prev) && isContainer(next) && Array.isArray(prev) === Array.isArray(next))
    return jsonpatch.compare(prev as object, next as object);
  return Object.is(prev, next) ? [] : [{ op: 'replace', path: '', value: next }];
}

// runs a channel's saves one at a time. Changes that arrive while a save is
// running fold into a single next save of the latest state (with every op
// and the earliest previous state), so a burst of changes is one write -
// and each change's promise settles with the save that covered it.
function createSaver<T>(save: (change: StateChange<T>) => MaybePromise<void>) {
  let running: Promise<void> = Promise.resolve();
  let queued: { change: StateChange<T>; saved: Promise<void> } | undefined;

  return (change: StateChange<T>): Promise<void> => {
    if (queued) {
      queued.change = { state: change.state, previous: queued.change.previous, ops: [...queued.change.ops, ...change.ops] };
      return queued.saved;
    }
    const entry = { change } as { change: StateChange<T>; saved: Promise<void> };
    entry.saved = running.then(() => {
      if (queued === entry) queued = undefined;
      return save(entry.change);
    });
    queued = entry;
    running = entry.saved.catch(() => { });
    return entry.saved;
  };
}

export async function createStore<C extends RpcStates>(
  channels: C,
  storage: StoreStorage<StateValues<C>>,
): Promise<RpcStore<StateValues<C>>> {
  type S = StateValues<C>;
  const names = Object.keys(channels) as (keyof S)[];
  const state = {} as S;
  const seqs = new Map<keyof S, number>();
  const savers = new Map<keyof S, (change: StateChange<unknown>) => Promise<void>>();
  const listeners = new Map<keyof S, Set<(patch: StatePatch) => void>>();

  for (const channel of names) {
    const channelStorage = storage[channel];
    if (!channelStorage) throw new Error(`no storage for state channel: ${String(channel)}`);
    state[channel] = structuredClone(await channelStorage.load());
    seqs.set(channel, 0);
    if (channelStorage.save) savers.set(channel, createSaver(channelStorage.save.bind(channelStorage) as (change: StateChange<unknown>) => MaybePromise<void>));
  }

  function assertChannel(channel: PropertyKey) {
    if (!seqs.has(channel as keyof S))
      throw new Error(`unknown state channel: ${String(channel)}`);
  }

  // a change to one channel, already worked out: the state it ends at and
  // the ops that took it there - sent to its watchers at once, and saved
  function commit(channel: keyof S, next: S[keyof S], ops: Operation[]) {
    const previous = state[channel];
    state[channel] = next;
    const seq = seqs.get(channel)! + 1;
    seqs.set(channel, seq);
    for (const listener of listeners.get(channel) ?? [])
      listener({ seq, ops });
    return savers.get(channel)?.({ state: next, previous, ops });
  }

  // a caller that doesn't await this mustn't crash the process when a save
  // fails - one that does still sees the error
  function settled(saves: (Promise<void> | undefined)[]) {
    const saved = Promise.all(saves).then(() => { });
    saved.catch(() => { });
    return saved;
  }

  function set(partial: Partial<S>) {
    const saves: (Promise<void> | undefined)[] = [];
    for (const channel of Object.keys(partial) as (keyof S)[]) {
      assertChannel(channel);
      // owned from here on, so a caller mutating what it passed in can't
      // change state behind the diff's back
      const next = structuredClone(partial[channel]) as S[keyof S];
      const ops = diff(state[channel], next);
      if (ops.length > 0) saves.push(commit(channel, next, ops));
    }
    return settled(saves);
  }

  return {
    get state() { return state; },
    seq: channel => {
      assertChannel(channel);
      return seqs.get(channel)!;
    },
    set,
    update(channel, edit) {
      assertChannel(channel);
      const draft = structuredClone(state[channel]);
      const result = edit(draft);
      return set({ [channel]: result === undefined ? draft : result } as unknown as Partial<S>);
    },
    patch(channel, ops) {
      assertChannel(channel);
      if (ops.length === 0) return settled([]);
      // applied to a copy, so ops that fail part way leave nothing behind,
      // and to ops of its own, so what's sent on shares nothing with state
      const next = jsonpatch.applyPatch(structuredClone(state[channel]), structuredClone(ops), true, true).newDocument;
      return settled([commit(channel, next, structuredClone(ops))]);
    },
    watch(channel, listener) {
      assertChannel(channel);
      let channelListeners = listeners.get(channel);
      if (!channelListeners) listeners.set(channel, channelListeners = new Set());
      channelListeners.add(listener);
      return {
        state: structuredClone(state[channel]),
        seq: seqs.get(channel)!,
        dispose: () => { channelListeners.delete(listener); },
      };
    },
  };
}

// the wire side, shared by every protocol: reserved under $/ so they never
// collide with a protocol's own methods
type SubscribeParams = { channel: string };
type SubscribeResult = { state: unknown; seq: number };
type PatchParams = { channel: string } & StatePatch;

const subscribeType = new RequestType<SubscribeParams, SubscribeResult, unknown>('$/state/subscribe');
const unsubscribeType = new NotificationType<SubscribeParams>('$/state/unsubscribe');
const patchType = new NotificationType<PatchParams>('$/state/patch');

// serves a store's channels to one connection: a subscribe answers with the
// channel's state and seq, and every patch after it follows as a
// notification, until it unsubscribes or the connection goes away
export function serveStore<S extends Record<string, unknown>>(connection: MessageConnection, store: RpcStore<S>) {
  const watches = new Map<string, () => void>();

  const unsubscribe = (channel: string) => {
    watches.get(channel)?.();
    watches.delete(channel);
  };

  // deliberately not async: the answer has to go out before any patch the
  // watch could send, and a synchronous handler's answer is written at once
  connection.onRequest(subscribeType, ({ channel }) => {
    unsubscribe(channel);
    // a patch to a connection that's going (closed, not yet noticed) just
    // never arrives - the close takes the watch away
    const watch = store.watch(channel, patch => {
      connection.sendNotification(patchType, { channel, ...patch }).catch(() => { });
    });
    watches.set(channel, watch.dispose);
    return { state: watch.state, seq: watch.seq };
  });
  connection.onNotification(unsubscribeType, ({ channel }) => unsubscribe(channel));

  const closeAll = () => {
    for (const channel of [...watches.keys()]) unsubscribe(channel);
  };
  connection.onClose(closeAll);
  connection.onDispose(closeAll);
}

// a JSON Pointer to the place these keys lead to, each escaped - so a key
// with a / or ~ in it is still one key
export const pointer = (...keys: string[]) => keys.map(key => `/${jsonpatch.escapePathComponent(key)}`).join('');

// a channel's ops moved under path in another one - to pass its changes on
// as one entry of a bigger state. A whole replace becomes an add there, so
// it works whether or not the entry is there yet.
export function prefixOps(ops: Operation[], path: string): Operation[] {
  return ops.map(op => op.path === '' && op.op === 'replace'
    ? { op: 'add', path, value: op.value }
    : { ...op, path: `${path}${op.path}`, ...'from' in op && { from: `${path}${op.from}` } } as Operation);
}

// what a subscription's listener is called with: the state, and the ops that
// took it there from the state the listener had - a whole replace for the
// first state, and whenever the channel had to be fetched again. The ops are
// the state's own values: read them, don't change them.
export type StateListener<T> = (state: T, ops: Operation[]) => void;

export type StateSubscription<T> = {
  // calls listener with the state now, then again after every change;
  // resolves once the first state has arrived, to what stops listening
  subscribe: (listener: StateListener<T>) => Promise<() => void>;
  // the latest state, while anything is subscribed
  readonly current: T | undefined;
};

export type ClientState<S extends Record<string, unknown>> = { [K in keyof S]: StateSubscription<S[K]> };

type Mirror = {
  listeners: Set<StateListener<any>>;
  state?: unknown;
  seq: number;
  // set while a subscribe is in flight; patches arriving meanwhile wait here
  pending?: Promise<void>;
  queued: PatchParams[];
};

// the client side: one subscription per channel per connection, however many
// listeners share it, kept current by applying each patch in order. A gap in
// seq means a patch went missing, so the channel resubscribes for a fresh
// state rather than guess.
export function mirrorState<S extends Record<string, unknown>>(connection: MessageConnection, channels: RpcStates): ClientState<S> {
  const mirrors = new Map<string, Mirror>();

  const whole = (mirror: Mirror): Operation[] => [{ op: 'replace', path: '', value: mirror.state }];
  const notify = (mirror: Mirror, ops: Operation[]) => {
    for (const listener of mirror.listeners) listener(mirror.state, ops);
  };

  function apply(mirror: Mirror, patch: PatchParams) {
    if (patch.seq <= mirror.seq) return;
    if (patch.seq !== mirror.seq + 1) {
      void resubscribe(patch.channel, mirror);
      return;
    }
    mirror.state = jsonpatch.applyPatch(mirror.state, patch.ops, false, false).newDocument;
    mirror.seq = patch.seq;
    notify(mirror, patch.ops);
  }

  async function resubscribe(channel: string, mirror: Mirror) {
    if (mirror.pending) return mirror.pending;
    mirror.pending = (async () => {
      try {
        const { state, seq } = await connection.sendRequest(subscribeType, { channel });
        mirror.state = state;
        mirror.seq = seq;
      } finally {
        mirror.pending = undefined;
      }
      const queued = mirror.queued.splice(0);
      notify(mirror, whole(mirror));
      for (const patch of queued) apply(mirror, patch);
    })();
    return mirror.pending;
  }

  connection.onNotification(patchType, patch => {
    const mirror = mirrors.get(patch.channel);
    if (!mirror) return;
    if (mirror.pending) mirror.queued.push(patch);
    else apply(mirror, patch);
  });

  const state: Record<string, StateSubscription<unknown>> = {};
  for (const channel of Object.keys(channels)) {
    state[channel] = {
      get current() { return mirrors.get(channel)?.state; },
      async subscribe(listener) {
        let mirror = mirrors.get(channel);
        if (!mirror) {
          mirror = { listeners: new Set(), seq: 0, queued: [] };
          mirrors.set(channel, mirror);
          mirror.listeners.add(listener);
          try {
            await resubscribe(channel, mirror);
          } catch (error) {
            mirrors.delete(channel);
            throw error;
          }
        } else {
          mirror.listeners.add(listener);
          // a snapshot in flight calls every listener once it lands
          if (mirror.pending) await mirror.pending;
          else listener(mirror.state, whole(mirror));
        }

        const subscribed = mirror;
        return () => {
          subscribed.listeners.delete(listener);
          if (subscribed.listeners.size > 0 || mirrors.get(channel) !== subscribed) return;
          mirrors.delete(channel);
          void connection.sendNotification(unsubscribeType, { channel }).catch(() => { });
        };
      },
    };
  }
  return state as ClientState<S>;
}
