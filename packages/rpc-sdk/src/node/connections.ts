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
import type { RpcProtocol, RpcPeer } from "../protocol.js";
import type { TransportParameters } from "../shared.js";

export const createStream = defineConnection(StreamMessageReader, StreamMessageWriter);

export const createStdio = () => createStream(process.stdin, process.stdout);

export const createSocket = defineDuplexConnection(SocketMessageReader, SocketMessageWriter);

export const createIPC = defineDuplexConnection(IPCMessageReader, IPCMessageWriter);

export const createPort = defineDuplexConnection(PortMessageReader, PortMessageWriter);

// stdio only ever has exactly one peer for its whole lifetime (there's no
// accept phase, unlike a WebSocketServer/net.Server), so unlike startWebSocket
// there's no separate "handle" to return - the one peer it ever has, is it.
export async function startStdio<P extends RpcProtocol>(
  parameters: TransportParameters<P, never>,
): Promise<RpcPeer<P['server']>> {
  const { protocol, configure } = parameters;
  const connection = createStdio();
  const peer = protocol.createServer(connection);
  configure?.(peer);
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
): RpcPeer<P['client']> {
  const child = spawn(options.command, options.args ?? [], { stdio: ['pipe', 'pipe', 'inherit'] });
  const connection = createStream(child.stdout, child.stdin);
  connection.onDispose(() => child.kill());
  return protocol.createClient(connection);
}

export async function startSocket<P extends RpcProtocol>(
  parameters: TransportParameters<P, ListenOptions>,
): Promise<Server> {
  const { protocol, configure, options } = parameters;
  const server = createServer(socket => {
    const connection = createSocket(socket);
    const peer = protocol.createServer(connection);
    configure?.(peer);
    peer.listen();
  });

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
): Promise<RpcPeer<P['client']>> {
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

  return protocol.createClient(createSocket(socket));
}