import { WebSocketServer, type ServerOptions } from 'ws';
import type { RpcProtocol } from '../../protocol.js';
import type { TransportParameters } from '../../shared.js';
import { createWebSocket } from '../connections.js';

// `ws` only binds (and emits its own 'listening') when it owns the socket -
// with `noServer: true` there's no binding at all, and with an external
// `server` passed in, that server owns its own listen() lifecycle instead.
export function waitForListening(server: WebSocketServer): Promise<WebSocketServer> {
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

export async function startWebSocket<P extends RpcProtocol>(
  parameters: TransportParameters<P, ServerOptions>,
): Promise<WebSocketServer> {
  const { protocol, configure, options } = parameters;
  const server = new WebSocketServer(options);

  server.on('connection', socket => {
    const connection = createWebSocket(socket);
    const peer = protocol.createServer(connection);
    configure?.(peer);
    peer.listen();
  });

  return waitForListening(server);
}
