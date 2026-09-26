import type { MessageConnection, Disposable } from "vscode-jsonrpc";
import { NotificationType, RequestType } from "vscode-jsonrpc";
import { MaybePromise } from "./shared.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Any = any;
export type AnyFunction = (...args: Any[]) => Any;

export type RpcRequest<P, R> = { type: RequestType<P, R, unknown>; };
export type RpcNotification<P> = { type: NotificationType<P>; };
export type RequestParams<T> = T extends RpcRequest<infer P, Any> ? P : never;
export type RequestResult<T> = T extends RpcRequest<Any, infer R> ? R : never;
export type NotificationParams<T> = T extends RpcNotification<infer P> ? P : never;

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
    dispose: () => connection.dispose()
  } as RpcPeer<Channel>;
}

export type RpcProtocol<Client extends RpcChannel = RpcChannel, Server extends RpcChannel = RpcChannel> = {
  client: Client;
  server: Server;
  createClient: (connection: MessageConnection) => RpcPeer<Client>;
  createServer: (connection: MessageConnection) => RpcPeer<Server>;
};
function protocol<Client extends RpcChannel, Server extends RpcChannel>(
  client: Client,
  server: Server,
): RpcProtocol<Client, Server> {
  return {
    client,
    server,
    createClient(connection) { return peer(client, connection); },
    createServer(connection) { return peer(server, connection); },
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

export type RpcProtocolSpec = Partial<{
  clientToServer: RpcSide;
  serverToClient: RpcSide;
  eitherToEither: RpcSide;
}>;
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
    >
  >;

export type ProtocolFactory<P extends RpcProtocolSpec> = (parameters: {
  side: typeof side;
  request: typeof request;
  notification: typeof notification;
}) => P;

export function defineProtocol<const P extends RpcProtocolSpec>(factory: ProtocolFactory<P>): Protocol<P> {
  const spec = factory({ side, request, notification });
  const clientToServer = getSide(spec, 'clientToServer');
  const serverToClient = getSide(spec, 'serverToClient');
  const eitherToEither = getSide(spec, 'eitherToEither');
  const client = channel(mergeSides(clientToServer, eitherToEither), mergeSides(serverToClient, eitherToEither));
  const server = channel(mergeSides(serverToClient, eitherToEither), mergeSides(clientToServer, eitherToEither));
  return protocol(client, server);
}