import { spawn } from "node:child_process";
import { createServer, createConnection, type Server, type ListenOptions, type NetConnectOpts } from "node:net";
import { defineDuplexConnection, defineConnection } from "../connections.js";
import {
  MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  SocketMessageReader,
  SocketMessageWriter,
  IPCMessageReader,
  IPCMessageWriter,
  PortMessageReader,
  PortMessageWriter,
} from "vscode-jsonrpc/node";
import type { ClientOf, RpcProtocol } from "../protocol.js";
import type { TransportParameters } from "../shared.js";

export const createStream = defineConnection(StreamMessageReader, StreamMessageWriter);

export const createStdio = () => createStream(process.stdin, process.stdout);

export const createSocket = defineDuplexConnection(SocketMessageReader, SocketMessageWriter);

export const createIPC = defineDuplexConnection(IPCMessageReader, IPCMessageWriter);

export const createPort = defineDuplexConnection(PortMessageReader, PortMessageWriter);

// stdio only ever has exactly one peer for its whole lifetime (there's no
// accept phase, unlike a WebSocketServer/net.Server), so unlike startWebSocket
// there's no separate "handle" to return - the one peer it ever has, is it.
export async function startStdio<T extends { listen: () => void }>(
  parameters: TransportParameters<never, T>,
): Promise<T> {
  const peer = parameters.accept(createStdio());
  peer.listen();
  return peer;
}

export type StdioConnectOptions = {
  command: string;
  args?: string[];
};

export function connectStdio<P extends RpcProtocol>(
  protocol: P,
  options: StdioConnectOptions,
): ClientOf<P> {
  const child = spawn(options.command, options.args ?? [], { stdio: ['pipe', 'pipe', 'inherit'] });
  const connection = createStream(child.stdout, child.stdin);
  connection.onDispose(() => child.kill());
  return protocol.createClient(connection) as ClientOf<P>;
}

export async function startSocket(
  parameters: TransportParameters<ListenOptions>,
): Promise<Server> {
  const { accept, options } = parameters;
  const server = createServer(socket => accept(createSocket(socket)).listen());

  return new Promise((resolve, reject) => {
    const onListening = () => {
      server.off('error', onError);
      resolve(server);
    };
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    server.once('listening', onListening);
    server.once('error', onError);
    server.listen(options);
  });
}

export async function connectSocket<P extends RpcProtocol>(
  protocol: P,
  options: NetConnectOpts,
): Promise<ClientOf<P>> {
  const socket = createConnection(options);

  await new Promise<void>((resolve, reject) => {
    const onConnect = () => {
      socket.off('error', onError);
      resolve();
    };
    const onError = (error: Error) => {
      socket.off('connect', onConnect);
      reject(error);
    };
    socket.once('connect', onConnect);
    socket.once('error', onError);
  });

  return protocol.createClient(createSocket(socket)) as ClientOf<P>;
}