import 'vscode-jsonrpc/node'; // installs the Node runtime abstraction layer WebSocketMessageReader/Writer need
import { WebSocketServer, type ServerOptions } from 'ws';
import type { TransportParameters } from '../../shared.js';
import { createWebSocket } from '../connections.js';

// `ws` only binds (and emits its own 'listening') when it owns the socket -
// with `noServer: true` there's no binding at all, and with an external
// `server` passed in, that server owns its own listen() lifecycle instead.
export function waitForWebSocketListening(server: WebSocketServer): Promise<WebSocketServer> {
  if (server.options.noServer)
    return Promise.resolve(server);

  const target = server.options.server ?? server;
  if ('listening' in target && target.listening)
    return Promise.resolve(server);

  return new Promise((resolve, reject) => {
    const onListening = () => {
      target.off('error', onError);
      resolve(server);
    };
    const onError = (error: Error) => {
      target.off('listening', onListening);
      reject(error);
    };
    target.once('listening', onListening);
    target.once('error', onError);
  });
}

export async function startWebSocket(
  parameters: TransportParameters<ServerOptions>,
): Promise<WebSocketServer> {
  const { accept, options } = parameters;
  const server = new WebSocketServer(options);
  server.on('connection', socket => accept(createWebSocket(socket)).listen());

  return waitForWebSocketListening(server);
}

export function getWebSocketUrl(server: WebSocketServer) {
  const addr = server.address();

  // 1. Fail early if it is an unconnectable UNIX domain socket file path
  if (!addr || typeof addr === 'string')
    throw new Error(`Cannot generate a standard browser WebSocket URL.`);

  // 2. Normalize the host address
  // '::' and '0.0.0.0' mean "listen on all network interfaces"
  let host = addr.address;
  if (host === '::' || host === '0.0.0.0') {
    host = 'localhost';
  } else if (addr.family === 'IPv6') {
    // IPv6 addresses must be wrapped in brackets for URLs (e.g., ws://[2001:db8::1]:8080)
    host = `[${host}]`;
  }

  // 3. Return the fully constructed connection string
  return `ws://${host}:${addr.port}`;
}

export function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close(error => {
      if (error) reject(error);
      else resolve();
    });
  });
}