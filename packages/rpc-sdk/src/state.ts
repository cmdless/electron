import jsonpatch from 'fast-json-patch';
import type { Operation } from 'fast-json-patch';
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
  // left out is untouched, and a deep edit goes through update instead
  set: (partial: Partial<S>) => void;
  // edits a copy of one channel's state; the draft is changed in place, or
  // a returned value replaces it
  update: <K extends keyof S>(channel: K, edit: (draft: S[K]) => S[K] | void) => void;
  // what a connection's subscription hangs off: the state to start from,
  // and every patch after it
  watch: <K extends keyof S>(channel: K, listener: (patch: StatePatch) => void) => StateWatch<S[K]>;
};

const isContainer = (value: unknown) => typeof value === 'object' && value !== null;

// compare only diffs objects and arrays - anything else (a number, a string,
// null, or a change between those and a container) replaces the whole value
function diff(prev: unknown, next: unknown): Operation[] {
  if (isContainer(prev) && isContainer(next) && Array.isArray(prev) === Array.isArray(next))
    return jsonpatch.compare(prev as object, next as object);
  return Object.is(prev, next) ? [] : [{ op: 'replace', path: '', value: next }];
}

export async function createStore<C extends RpcStates>(
  channels: C,
  init: () => MaybePromise<StateValues<C>>,
): Promise<RpcStore<StateValues<C>>> {
  type S = StateValues<C>;
  const state = structuredClone(await init()) as S;
  const seqs = new Map<keyof S, number>(Object.keys(channels).map(channel => [channel, 0]));
  const listeners = new Map<keyof S, Set<(patch: StatePatch) => void>>();

  function assertChannel(channel: PropertyKey) {
    if (!seqs.has(channel as keyof S))
      throw new Error(`unknown state channel: ${String(channel)}`);
  }

  function set(partial: Partial<S>) {
    for (const channel of Object.keys(partial) as (keyof S)[]) {
      assertChannel(channel);
      // owned from here on, so a caller mutating what it passed in can't
      // change state behind the diff's back
      const next = structuredClone(partial[channel]) as S[keyof S];
      const ops = diff(state[channel], next);
      if (ops.length === 0) continue;

      state[channel] = next;
      const seq = seqs.get(channel)! + 1;
      seqs.set(channel, seq);
      for (const listener of listeners.get(channel) ?? [])
        listener({ seq, ops });
    }
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
      set({ [channel]: result === undefined ? draft : result } as unknown as Partial<S>);
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
