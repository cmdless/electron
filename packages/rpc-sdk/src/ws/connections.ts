import { toSocket, WebSocketMessageReader, WebSocketMessageWriter } from 'vscode-ws-jsonrpc';
import { createMessageConnection } from 'vscode-jsonrpc';
import type { EitherWebSocket } from './shared.js';
import type { RpcProtocol, RpcPeer } from '../protocol.js';

export async function waitForOpen<T extends EitherWebSocket>(socket: T) {
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

  return createMessageConnection(
    new WebSocketMessageReader(adapted),
    new WebSocketMessageWriter(adapted),
  );
}

export type WebSocketConnectOptions = {
  url: string | URL;
  protocols?: string | string[];
};

export async function connectWebSocket<P extends RpcProtocol>(
  protocol: P,
  options: WebSocketConnectOptions,
): Promise<RpcPeer<P['client']>> {
  const socket = new WebSocket(options.url, options.protocols);
  await waitForOpen(socket);
  return protocol.createClient(createWebSocket(socket));
}