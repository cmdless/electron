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

export const createStream = defineConnection(StreamMessageReader, StreamMessageWriter);

export const createStdio = () => createStream(process.stdin, process.stdout);

export const createSocket = defineDuplexConnection(SocketMessageReader, SocketMessageWriter);

export const createIPC = defineDuplexConnection(IPCMessageReader, IPCMessageWriter);

export const createPort = defineDuplexConnection(PortMessageReader, PortMessageWriter);