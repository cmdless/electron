import type { MessageConnection, Disposable } from "vscode-jsonrpc";
import { NotificationType, RequestType } from "vscode-jsonrpc";
import { MaybePromise } from "./shared.js";
import { createStore, mirrorState, serveStore } from "./state.js";
import type { ClientState, RpcStore, StoreStorage } from "./state.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Any = any;
export type AnyFunction = (...args: Any[]) => Any;

export type RpcRequest<P, R> = { type: RequestType<P, R, unknown>; };
export type RpcNotification<P> = { type: NotificationType<P>; };
export type RequestParams<T> = T extends RpcRequest<infer P, Any> ? P : never;
export type RequestResult<T> = T extends RpcRequest<Any, infer R> ? R : never;
export type NotificationParams<T> = T extends RpcNotification<infer P> ? P : never;

// a state channel: a named piece of server-owned state clients can subscribe
// to. `_state` only carries the type, like RequestType does for its params.
export type RpcState<S> = { name: string; _state?: S; };
export type RpcStates = Record<string, RpcState<Any>>;
export type StateValues<C extends RpcStates> = { [K in keyof C]: C[K] extends RpcState<infer S> ? S : never };

export type RpcRequests = Record<string, RpcRequest<Any, Any>>;
export type RpcNotifications = Record<string, RpcNotification<Any>>;
export type RpcSide<
  R extends RpcRequests = RpcRequests,
  N extends RpcNotifications = RpcNotifications
> = {
  requests: R;
  notifications: N;
};

export type MergeSides<
  A extends RpcSide,
  B extends RpcSide
> = RpcSide<
  A['requests'] & B['requests'] & RpcRequests,
  A['notifications'] & B['notifications'] & RpcNotifications
>;
function mergeSides<A extends RpcSide, B extends RpcSide>(a: A, b: B): MergeSides<A, B> {
  return {
    requests: { ...a.requests, ...b.requests },
    notifications: { ...a.notifications, ...b.notifications },
  };
}

export type RpcChannel<Outgoing extends RpcSide = RpcSide, Incoming extends RpcSide = RpcSide> = {
  outgoing: Outgoing;
  incoming: Incoming;
};
function channel<Outgoing extends RpcSide, Incoming extends RpcSide>(
  outgoing: Outgoing,
  incoming: Incoming
): RpcChannel<Outgoing, Incoming> {
  return { outgoing, incoming };
}

export type RequestSenders<R extends RpcSide['requests']> = {
  [K in keyof R]: [RequestParams<R[K]>] extends [void]
  ? () => Promise<RequestResult<R[K]>>
  : (params: RequestParams<R[K]>) => Promise<RequestResult<R[K]>>;
};
export type NotificationSenders<N extends RpcSide['notifications']> = {
  [K in keyof N]: [NotificationParams<N[K]>] extends [void]
  ? () => void
  : (params: NotificationParams<N[K]>) => void;
};
export type RequestHandlers<R extends RpcSide['requests']> = {
  [K in keyof R]: [RequestParams<R[K]>] extends [void]
  ? (handler: () => MaybePromise<RequestResult<R[K]>>) => Disposable
  : (handler: (params: RequestParams<R[K]>) => MaybePromise<RequestResult<R[K]>>) => Disposable;
};
export type NotificationHandlers<N extends RpcSide['notifications']> = {
  [K in keyof N]: [NotificationParams<N[K]>] extends [void]
  ? (handler: () => MaybePromise<void>) => Disposable
  : (handler: (params: NotificationParams<N[K]>) => MaybePromise<void>) => Disposable;
};

export type RpcPeer<Channel extends RpcChannel = RpcChannel> = {
  request: RequestSenders<Channel['outgoing']['requests']>;
  notify: NotificationSenders<Channel['outgoing']['notifications']>;
  onRequest: RequestHandlers<Channel['incoming']['requests']>;
  onNotification: NotificationHandlers<Channel['incoming']['notifications']>;
  listen: () => void;
  dispose: () => void;
  // called once when the connection ends, whether it closed or was disposed
  onClose: (listener: () => void) => Disposable;
};
function peer<Channel extends RpcChannel>(
  { outgoing, incoming }: Channel,
  connection: MessageConnection,
): RpcPeer<Channel> {
  const request: Record<string, AnyFunction> = {};
  const notify: Record<string, AnyFunction> = {};
  const onRequest: Record<string, AnyFunction> = {};
  const onNotification: Record<string, AnyFunction> = {};

  for (const [name, definition] of Object.entries(outgoing.requests)) {
    request[name] = (params: unknown) =>
      connection.sendRequest(definition.type, params);
  }

  for (const [name, definition] of Object.entries(outgoing.notifications)) {
    notify[name] = (params: unknown) =>
      connection.sendNotification(definition.type, params);
  }

  for (const [name, definition] of Object.entries(incoming.requests)) {
    onRequest[name] = (handler: AnyFunction) =>
      connection.onRequest(definition.type, handler as Any);
  }

  for (const [name, definition] of Object.entries(incoming.notifications)) {
    onNotification[name] = (handler: AnyFunction) =>
      connection.onNotification(definition.type, handler as Any);
  }

  return {
    request,
    notify,
    onRequest,
    onNotification,
    listen: () => connection.listen(),
    dispose: () => connection.dispose(),
    onClose: (listener: () => void) => {
      let ended = false;
      const end = () => {
        if (ended) return;
        ended = true;
        listener();
      };
      const closed = connection.onClose(end);
      const disposed = connection.onDispose(end);
      return { dispose: () => { closed.dispose(); disposed.dispose(); } };
    },
  } as RpcPeer<Channel>;
}

type HasState<S> = keyof S extends never ? false : true;

// the store a server is given: required when the protocol declares state
// channels, absent when it doesn't
export type ServerStore<S extends Record<string, unknown>> =
  HasState<S> extends true ? RpcStore<S> : undefined;

// what a server peer can do with the shared store. It's the same store for
// every connection, so set and update change state for all of them.
export type ServerState<S extends Record<string, unknown>> =
  HasState<S> extends true
  ? Pick<RpcStore<S>, 'set' | 'update'> & { readonly current: Readonly<S> }
  : {};

export type RpcClient<Channel extends RpcChannel = RpcChannel, S extends Record<string, unknown> = {}> =
  RpcPeer<Channel> & { state: ClientState<S> };
export type RpcServer<Channel extends RpcChannel = RpcChannel, S extends Record<string, unknown> = {}> =
  RpcPeer<Channel> & { state: ServerState<S> };

// all a client side needs of a protocol - narrower than RpcProtocol, which
// a protocol with state channels doesn't fit (its createServer needs a store)
export type ClientProtocol = Pick<RpcProtocol, 'createClient'>;

// the client a protocol creates, with its state channels typed
export type ClientOf<P extends ClientProtocol> = ReturnType<P['createClient']>;

function createRpcClient<Channel extends RpcChannel, S extends Record<string, unknown>>(
  channel: Channel,
  connection: MessageConnection,
  states: RpcStates,
): RpcClient<Channel, S> {
  return { ...peer(channel, connection), state: mirrorState<S>(connection, states) };
}

function createRpcServer<Channel extends RpcChannel, S extends Record<string, unknown>>(
  channel: Channel,
  connection: MessageConnection,
  store: ServerStore<S>,
): RpcServer<Channel, S> {
  if (store) serveStore(connection, store);
  const state = store
    ? { get current() { return store.state; }, set: store.set, update: store.update }
    : {};
  return { ...peer(channel, connection), state: state as ServerState<S> };
}

// createServer's store argument: required when the protocol declares state
// channels, not taken when it doesn't
export type ServerStoreArgs<S extends Record<string, unknown>> =
  HasState<S> extends true ? [store: RpcStore<S>] : [];

// a running server: one store, and what each new connection is handed to
export type RpcHost<Channel extends RpcChannel, S extends Record<string, unknown>> = {
  store: ServerStore<S>;
  accept: (connection: MessageConnection) => RpcServer<Channel, S>;
};

// everything about a server that's the same for every connection: the
// handlers each one gets, and - when the protocol declares state channels -
// where each channel's state is kept (memory(), or file() from /node, ...)
export type HostDefinition<Channel extends RpcChannel, S extends Record<string, unknown>> = {
  configure?: (server: RpcServer<Channel, S>, store: ServerStore<S>) => void;
} & (HasState<S> extends true ? { state: StoreStorage<S> } : { state?: undefined });

export type RpcProtocol<
  Client extends RpcChannel = RpcChannel,
  Server extends RpcChannel = RpcChannel,
  States extends RpcStates = {},
> = {
  client: Client;
  server: Server;
  state: States;
  createClient: (connection: MessageConnection) => RpcClient<Client, StateValues<States>>;

  // these are methods, not function properties, so a specific protocol
  // still fits where the generic RpcProtocol is asked for (method
  // parameters are checked bivariantly, and these take state-typed args)

  // one store per server, shared by every connection to it
  createStore(storage: StoreStorage<StateValues<States>>): Promise<RpcStore<StateValues<States>>>;

  // one unconfigured server peer - what a host's accept is built on, and
  // what a test reaches for directly
  createServer(connection: MessageConnection, ...store: ServerStoreArgs<StateValues<States>>): RpcServer<Server, StateValues<States>>;
  // defines a server once; each call of what it returns starts one - the
  // store, and an accept that turns each connection into a configured peer,
  // ready to listen
  defineHost(definition: HostDefinition<Server, StateValues<States>>): () => Promise<RpcHost<Server, StateValues<States>>>;
};
function protocol<Client extends RpcChannel, Server extends RpcChannel, States extends RpcStates>(
  client: Client,
  server: Server,
  state: States,
): RpcProtocol<Client, Server, States> {
  type S = StateValues<States>;

  function createServer(connection: MessageConnection, ...[store]: ServerStoreArgs<S>) {
    return createRpcServer<Server, S>(server, connection, store as ServerStore<S>);
  }

  return {
    client,
    server,
    state,
    createClient(connection) { return createRpcClient<Client, S>(client, connection, state); },
    createStore(storage) { return createStore(state, storage); },
    createServer,
    defineHost({ configure, state: storage }) {
      return async () => {
        const store = (storage ? await createStore(state, storage) : undefined) as ServerStore<S>;
        const accept = (connection: MessageConnection) => {
          const rpc = createServer(connection, ...([store] as ServerStoreArgs<S>));
          configure?.(rpc, store);
          return rpc;
        };
        return { store, accept };
      };
    },
  };
}

function side<R extends RpcRequests, N extends RpcNotifications>(
  value?: Partial<RpcSide<R, N>>
): RpcSide<R, N> {
  return {
    requests: value?.requests ?? {} as R,
    notifications: value?.notifications ?? {} as N,
  };
}
function getSide<P extends RpcProtocolSpec, K extends keyof RpcProtocolSpec>(spec: P, key: K): SideOf<P, K> {
  return (spec[key] ?? side()) as SideOf<P, K>;
}
function request(method: string): RpcRequest<void, void>;
function request<P, R>(method: string): RpcRequest<P, R>;
function request<P, R>(method: string): RpcRequest<P, R> {
  return { type: new RequestType<P, R, unknown>(method) };
}

function notification(method: string): RpcNotification<void>;
function notification<P>(method: string): RpcNotification<P>;
function notification<P>(method: string): RpcNotification<P> {
  return { type: new NotificationType<P>(method) };
}

function state<S>(name: string): RpcState<S> {
  return { name };
}

export type RpcProtocolSpec = Partial<{
  clientToServer: RpcSide;
  serverToClient: RpcSide;
  eitherToEither: RpcSide;
  state: RpcStates;
}>;
export type StatesOf<P> = P extends { state: infer C extends RpcStates } ? C : {};
export type EmptySide = RpcSide<RpcRequests, RpcNotifications>;
export type SideOf<P, K extends keyof RpcProtocolSpec> = K extends keyof P ? P[K] extends RpcSide ? P[K] : EmptySide : EmptySide;
export type Protocol<P extends RpcProtocolSpec> =
  RpcProtocol<
    RpcChannel<
      MergeSides<SideOf<P, 'clientToServer'>, SideOf<P, 'eitherToEither'>>,
      MergeSides<SideOf<P, 'serverToClient'>, SideOf<P, 'eitherToEither'>>
    >,
    RpcChannel<
      MergeSides<SideOf<P, 'serverToClient'>, SideOf<P, 'eitherToEither'>>,
      MergeSides<SideOf<P, 'clientToServer'>, SideOf<P, 'eitherToEither'>>
    >,
    StatesOf<P>
  >;

export type ProtocolFactory<P extends RpcProtocolSpec> = (parameters: {
  side: typeof side;
  request: typeof request;
  notification: typeof notification;
  state: typeof state;
}) => P;

export function defineProtocol<const P extends RpcProtocolSpec>(factory: ProtocolFactory<P>): Protocol<P> {
  const spec = factory({ side, request, notification, state });
  const clientToServer = getSide(spec, 'clientToServer');
  const serverToClient = getSide(spec, 'serverToClient');
  const eitherToEither = getSide(spec, 'eitherToEither');
  const client = channel(mergeSides(clientToServer, eitherToEither), mergeSides(serverToClient, eitherToEither));
  const server = channel(mergeSides(serverToClient, eitherToEither), mergeSides(clientToServer, eitherToEither));
  return protocol(client, server, (spec.state ?? {}) as StatesOf<P>);
}