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
  `connectBrowser(protocol, source, target?)` — same endpoint(s), but returns a ready-to-use **client peer** directly (`protocol.createClient(createBrowser(...))`). No waiting involved — unlike a WebSocket/TCP connection, `postMessage`-based endpoints queue messages automatically, there's no "not open yet" state to wait out.

  ```ts
  import { createBrowser, connectBrowser } from '@cmdless/rpc-sdk/browser';
  import { myProtocol } from './protocol.js';

  const connection = createBrowser(self); // e.g. inside a Worker
  const client = connectBrowser(myProtocol, self);
  client.listen();
  ```

- **`@cmdless/rpc-sdk/node`** — every helper here builds a `MessageConnection` from an explicit `vscode-jsonrpc/node` reader/writer pair chosen for that specific transport, rather than a one-size-fits-all path, since the different Node transports aren't just "bytes with different cleanup" — IPC and worker ports are already message-framed, not raw byte streams like plain streams/sockets are.

  - `createStream(input, output)` / `createStream(duplex)` — plain `Readable`/`Writable` streams (files, pipes, `PassThrough`, etc.), via `StreamMessageReader`/`StreamMessageWriter`. Use `createSocket` instead for a `net.Socket` — it'll type-check either way, but only `createSocket` disposes of the connection correctly.
  - `createStdio()` — `createStream(process.stdin, process.stdout)`.
  - `createSocket(socket)` — a `net.Socket`, via `SocketMessageReader`/`SocketMessageWriter`, which dispose of the connection correctly (closing the socket) unlike the generic stream writer.
  - `createIPC(target)` — a `ChildProcess` or `NodeJS.Process`, via `IPCMessageReader`/`IPCMessageWriter`, built on `process.send()`/`'message'` events (e.g. the channel between a Node parent and a `child_process.spawn(..., { stdio: [..., 'ipc'] })` child).
  - `createPort(port)` — a `MessagePort` or `Worker` from `node:worker_threads`, via `PortMessageReader`/`PortMessageWriter`.
  - `startStdio({ protocol, configure? })` — `createStdio()` is the *server* side of a stdio transport (a spawned process's own stdin/stdout, same convention as LSP-over-stdio); this creates the server peer, runs `configure`, and calls `.listen()` for you. Unlike `startWebSocket`, this returns the **peer itself**, not a separate handle — stdio only ever has exactly one peer for its whole lifetime, there's no accept phase to hand back a handle for.
  - `connectStdio(protocol, { command, args? })` — the client side: spawns `command`, wraps its stdout/stdin from the outside, and returns a ready **client peer** (call `.listen()` yourself when ready, same as `connectWebSocket` — no `configure` needed since you already have the peer to register handlers on directly). Disposing the returned peer's connection also kills the spawned process. Deliberately doesn't expose the full `SpawnOptions` surface — some of those need to stay fixed (e.g. `stdio: ['pipe', 'pipe', 'inherit']`) for the wiring to work at all.
  - `startSocket({ protocol, configure?, options? })` — a plain `net.Server`: creates it, calls `.listen(options)` (`options` are `net.ListenOptions`, e.g. `{ port: 9000 }`), and for every accepted `net.Socket` wraps it via `createSocket`, creates a server peer, runs `configure`, and calls `.listen()` for you — same shape as `startWebSocket`, returning the server handle since many peers can connect over its lifetime.
  - `connectSocket(protocol, options)` — the client side: `net.createConnection(options)` (`options` are `net.NetConnectOpts`, e.g. `{ port: 9000, host: 'localhost' }` or `{ path: '/tmp/my.sock' }`), waits for `'connect'`, and returns a ready **client peer** (same "you call `.listen()`" convention as `connectStdio`/`connectWebSocket`).

  ```ts
  import { createStdio, startStdio, connectStdio } from '@cmdless/rpc-sdk/node';
  import { myProtocol } from './protocol.js';

  const connection = createStdio(); // process.stdin / process.stdout, wrapped directly

  // or, as the server side of a protocol:
  const server = await startStdio({
    protocol: myProtocol,
    configure(peer) { peer.onRequest.ping(async () => ({ ok: true })); },
  });

  // and from whoever spawns that process:
  const client = connectStdio(myProtocol, { command: 'my-server', args: ['--flag'] });
  client.listen();
  ```

- **`@cmdless/rpc-sdk/ws`** — for the standard `WebSocket`. `vscode-ws-jsonrpc`'s `toSocket`/`WebSocketMessageReader`/`WebSocketMessageWriter` only ever touch `send`/`onmessage`/`onerror`/`onclose`/`close` — the same shape both a real browser `WebSocket` and the `ws` package's `WebSocket` class provide — so this one module works from either a browser and a Node process connecting *out*, or (once added) a Node server wrapping an *accepted* connection.

  - `createWebSocket(socket)` — wraps an already-open `WebSocket` (browser or `ws`) into a `MessageConnection`.
  - `waitForOpen(socket)` — resolves once a connecting socket reaches `OPEN` (or rejects on error/if it's already closed/closing).
  - `connectWebSocket(protocol, { url, protocols? })` — creates `new WebSocket(url, protocols)` (the same global constructor in a browser and in modern Node — no environment branching needed), waits for it to open, and returns a ready-to-use **client peer** (call `.listen()` yourself when ready, same convention as `connectStdio`/`connectSocket`).

  ```ts
  import { connectWebSocket } from '@cmdless/rpc-sdk/ws';
  import { myProtocol } from './protocol.js';

  const client = await connectWebSocket(myProtocol, { url: 'wss://example.test' });
  client.listen();
  ```

  Kept as its own export rather than in the shared root module so that consumers who never touch WebSockets don't pull in `vscode-ws-jsonrpc` at all.

- **`@cmdless/rpc-sdk/ws/node`** — the server-listening side, built on the `ws` package. Node-only (unlike `@cmdless/rpc-sdk/ws`, which is safe from a browser too) — this is the one place that actually needs `ws` at runtime, not just its types.

  - `startWebSocket({ protocol, configure?, options? })` — starts a `ws` `WebSocketServer` (`options` are `ws`'s own `ServerOptions`, e.g. `{ port: 8080 }`), resolving once it's actually listening (see `waitForListening` below), and for every accepted connection: wraps it via `createWebSocket` from `@cmdless/rpc-sdk/ws`, creates a server peer with `protocol.createServer(connection)`, calls your `configure(peer)` hook to register `onRequest`/`onNotification` handlers, then calls `peer.listen()` for you.
  - `waitForListening(server)` — resolves once the server is actually ready to accept connections, reading `server.options` to pick the right signal: immediately for `noServer: true` (nothing to bind), immediately if an externally-provided `server` is already listening, otherwise waiting for that external server's (or `ws`'s own) `'listening'` event — rejecting on `'error'` in the waiting case.

  ```ts
  import { startWebSocket } from '@cmdless/rpc-sdk/ws/node';
  import { myProtocol } from './protocol.js';

  const server = await startWebSocket({
    protocol: myProtocol,
    options: { port: 8080 },
    configure(peer) {
      peer.onRequest.ping(async () => ({ ok: true }));
    },
  });
  ```

  `TransportParameters<P, Options>` (the `{ protocol, configure, options }` shape) is exported from the package root, not this module — it's meant to be reused by future "start a transport server" helpers beyond just WebSocket.

## Exports

| Export | Contents |
| --- | --- |
| `@cmdless/rpc-sdk` | `defineProtocol`, the protocol/side/channel/peer types, and `TransportParameters` |
| `@cmdless/rpc-sdk/browser` | `createBrowser`, `connectBrowser` |
| `@cmdless/rpc-sdk/node` | `createStream`, `createStdio`, `createSocket`, `createIPC`, `createPort`, `startStdio`, `connectStdio`, `startSocket`, `connectSocket` |
| `@cmdless/rpc-sdk/ws` | `createWebSocket`, `waitForOpen`, `connectWebSocket` |
| `@cmdless/rpc-sdk/ws/node` | `startWebSocket`, `waitForListening` |
