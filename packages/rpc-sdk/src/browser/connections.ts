import { defineConnection } from "../connections.js";
import {
  BrowserMessageReader,
  BrowserMessageWriter,
} from "vscode-jsonrpc/browser";
import type { RpcProtocol, RpcPeer } from "../protocol.js";

type BrowserSource = ConstructorParameters<typeof BrowserMessageReader>[0];
type BrowserTarget = ConstructorParameters<typeof BrowserMessageWriter>[0];

export const createBrowser = defineConnection(BrowserMessageReader, BrowserMessageWriter);

// postMessage-based endpoints (Worker, MessagePort, Window) queue messages
// automatically - unlike a WebSocket/TCP connection, there's no "not open
// yet" state to wait out, so this is a plain synchronous wrapper.
export function connectBrowser<P extends RpcProtocol>(
  protocol: P,
  source: BrowserSource,
  target: BrowserTarget = source as unknown as BrowserTarget,
): RpcPeer<P['client']> {
  return protocol.createClient(createBrowser(source, target));
}