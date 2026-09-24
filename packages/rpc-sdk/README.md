# @cmdless/rpc-sdk

RPC SDK built on top of [`vscode-jsonrpc`](https://www.npmjs.com/package/vscode-jsonrpc). Define a JSON-RPC protocol once, and generate strongly-typed peers for both sides of the connection — client and server — from that single definition.

## Why

`vscode-jsonrpc` gives you a `MessageConnection` and lets you call `sendRequest`/`onRequest` with a `RequestType` per method. Doing that by hand means duplicating the same method names and payload shapes on both ends, with nothing tying them together. `@cmdless/rpc-sdk` lets you describe the whole protocol — which side sends what — once, and get back typed `request`/`notify`/`onRequest`/`onNotification` functions for each side, generated from that single source of truth.

## Install

```
npm install @cmdless/rpc-sdk vscode-jsonrpc
```

## Defining a protocol

```ts
import { defineProtocol } from '@cmdless/rpc-sdk';

export const protocol = defineProtocol(({ side, request, notification }) => ({
  clientToServer: side({
    requests: {
      ping: request<{ text: string }, { text: string }>('ping'),
    },
  }),
  serverToClient: side({
    notifications: {
      log: notification<{ message: string }>('log'),
    },
  }),
  eitherToEither: side({
    notifications: {
      heartbeat: notification<void>('heartbeat'),
    },
  }),
}));
```

A protocol spec has three optional sections, each built with `side({ requests, notifications })`:

- `clientToServer` — only the client can send these; only the server can receive them.
- `serverToClient` — the reverse.
- `eitherToEither` — either side can send and receive (e.g. a shared heartbeat).

`request<Params, Result>(method)` and `notification<Params>(method)` declare a single method's shape and wire name. They're handed to you as arguments of the factory function passed to `defineProtocol` — there's no need to import them separately.

## Creating peers

Once you have a `MessageConnection` (from `vscode-jsonrpc`, `vscode-jsonrpc/node`, or `vscode-jsonrpc/browser` — see [Transports](#transports) below), turn the protocol into a peer for whichever side you're on:

```ts
// server side
const server = protocol.createServer(connection);
server.onRequest.ping(async ({ text }) => ({ text: text.toUpperCase() }));
server.listen();

// client side
const client = protocol.createClient(connection);
client.listen();
const { text } = await client.request.ping({ text: 'hello' });
```

Every peer returned by `createClient`/`createServer` exposes:

- `request` — typed senders for the requests this side can send.
- `notify` — typed senders for the notifications this side can send.
- `onRequest` — typed handler registration for requests this side receives.
- `onNotification` — typed handler registration for notifications this side receives.
- `listen()` — starts the underlying `MessageConnection`. Call this once both sides have registered their handlers.

Types flow end to end: the `params`/`result` types for `ping` above come straight from the `request<{ text: string }, { text: string }>('ping')` declaration, on both the client and server peer.

## Transports

- **`@cmdless/rpc-sdk/browser`** — `createBrowser(source, target?)` wraps `vscode-jsonrpc/browser`'s `BrowserMessageReader`/`BrowserMessageWriter` around anything shaped like a `postMessage`/`addEventListener('message')` endpoint into a `MessageConnection`. Fits a `Worker`, a `MessagePort`, or a WebView2 message bridge. Pass one endpoint if it serves as both source and target, or a separate source/target pair.

  ```ts
  import { createBrowser } from '@cmdless/rpc-sdk/browser';

  const connection = createBrowser(self); // e.g. inside a Worker
  ```

- **`@cmdless/rpc-sdk/node`** — every helper here builds a `MessageConnection` from an explicit `vscode-jsonrpc/node` reader/writer pair chosen for that specific transport, rather than a one-size-fits-all path, since the different Node transports aren't just "bytes with different cleanup" — IPC and worker ports are already message-framed, not raw byte streams like plain streams/sockets are.

  - `createStream(input, output)` / `createStream(duplex)` — plain `Readable`/`Writable` streams (files, pipes, `PassThrough`, etc.), via `StreamMessageReader`/`StreamMessageWriter`. Use `createSocket` instead for a `net.Socket` — it'll type-check either way, but only `createSocket` disposes of the connection correctly.
  - `createStdio()` — `createStream(process.stdin, process.stdout)`.
  - `createSocket(socket)` — a `net.Socket`, via `SocketMessageReader`/`SocketMessageWriter`, which dispose of the connection correctly (closing the socket) unlike the generic stream writer.
  - `createIPC(target)` — a `ChildProcess` or `NodeJS.Process`, via `IPCMessageReader`/`IPCMessageWriter`, built on `process.send()`/`'message'` events (e.g. the channel between a Node parent and a `child_process.spawn(..., { stdio: [..., 'ipc'] })` child).
  - `createPort(port)` — a `MessagePort` or `Worker` from `node:worker_threads`, via `PortMessageReader`/`PortMessageWriter`.

  ```ts
  import { createStdio } from '@cmdless/rpc-sdk/node';

  const connection = createStdio(); // process.stdin / process.stdout
  ```

- **`@cmdless/rpc-sdk/ws`** — for the standard `WebSocket` (available in both browsers and modern Node), via `vscode-ws-jsonrpc`'s `WebSocketMessageReader`/`WebSocketMessageWriter`.

  - `createWebSocket(socket)` — wraps an already-open `WebSocket`.
  - `waitForOpen(socket)` — resolves once a connecting socket reaches `OPEN` (or rejects on error/if it's already closed/closing).
  - `connectWebSocket(factory)` — `createWebSocket(await waitForOpen(await factory()))` in one call; `factory` can return a `WebSocket` or a `Promise<WebSocket>`.

  ```ts
  import { connectWebSocket } from '@cmdless/rpc-sdk/ws';

  const connection = await connectWebSocket(() => new WebSocket('wss://example.test'));
  ```

  Kept as its own export rather than in the shared root module so that consumers who never touch WebSockets don't pull in `vscode-ws-jsonrpc` at all.

## Exports

| Export | Contents |
| --- | --- |
| `@cmdless/rpc-sdk` | `defineProtocol` and the protocol/side/channel/peer types |
| `@cmdless/rpc-sdk/browser` | `createBrowser` |
| `@cmdless/rpc-sdk/node` | `createStream`, `createStdio`, `createSocket`, `createIPC`, `createPort` |
| `@cmdless/rpc-sdk/ws` | `createWebSocket`, `waitForOpen`, `connectWebSocket` |
