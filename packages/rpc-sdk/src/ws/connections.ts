import '#ral'; // installs vscode-jsonrpc's runtime layer for whichever environment this runs in
import { toSocket, WebSocketMessageReader, WebSocketMessageWriter } from 'vscode-ws-jsonrpc';
import { createMessageConnection } from 'vscode-jsonrpc';
import type { EitherWebSocket } from './shared.js';
import type { ClientOf, ClientProtocol } from '../protocol.js';

export async function waitForWebSocketOpen<T extends EitherWebSocket>(socket: T) {
  if (socket.readyState === WebSocket.OPEN)
    return socket;

  if (socket.readyState === WebSocket.CLOSING || socket.readyState === WebSocket.CLOSED)
    throw new Error("WebSocket is not open and cannot be opened.");

  return await new Promise<T>((resolve, reject) => {
    const controller = new AbortController();
    socket.addEventListener("open", () => {
      controller.abort();
      resolve(socket);
    }, { once: true, signal: controller.signal });
    socket.addEventListener("error", () => {
      controller.abort();
      reject(new Error("WebSocket connection failed"));
    }, { once: true, signal: controller.signal });
  });
}

export function createWebSocket(socket: EitherWebSocket) {
  // toSocket() is typed against the DOM WebSocket, but its actual implementation
  // only ever touches send/onmessage/onerror/onclose/close - the same shape a
  // `ws`-package socket has too, so this works correctly for either at runtime.
  const adapted = toSocket(socket as unknown as WebSocket);

  const connection = createMessageConnection(
    new WebSocketMessageReader(adapted),
    new WebSocketMessageWriter(adapted),
  );
  // unlike the Node socket transport (whose SocketMessageWriter.dispose()
  // destroys the socket), vscode-ws-jsonrpc's WebSocketMessageWriter never
  // closes the underlying socket - without this, disposing a peer leaves the
  // raw connection (and the process) alive.
  connection.onDispose(() => adapted.dispose());
  return connection;
}

export type WebSocketConnectOptions = {
  url: string | URL;
  protocols?: string | string[];
};

export async function connectWebSocket<P extends ClientProtocol>(
  protocol: P,
  options: WebSocketConnectOptions,
): Promise<ClientOf<P>> {
  const socket = new WebSocket(options.url, options.protocols);
  await waitForWebSocketOpen(socket);
  return protocol.createClient(createWebSocket(socket)) as ClientOf<P>;
}