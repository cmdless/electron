import { toSocket, WebSocketMessageReader, WebSocketMessageWriter } from 'vscode-ws-jsonrpc';
import { createMessageConnection } from 'vscode-jsonrpc';
import type { MaybePromise } from '../shared.js';

export async function waitForOpen(socket: WebSocket) {
  if (socket.readyState === WebSocket.OPEN)
    return socket;

  if (socket.readyState === WebSocket.CLOSING || socket.readyState === WebSocket.CLOSED)
    throw new Error("WebSocket is not open and cannot be opened.");

  return await new Promise<WebSocket>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(socket), { once: true });
    socket.addEventListener("error", () => reject(new Error("WebSocket connection failed")), { once: true });
  });
}

export function createWebSocket(socket: WebSocket) {
  const adapted = toSocket(socket);

  return createMessageConnection(
    new WebSocketMessageReader(adapted),
    new WebSocketMessageWriter(adapted),
  );
}

export async function connectWebSocket(factory: () => MaybePromise<WebSocket>) {
  return createWebSocket(await waitForOpen(await factory()));
}