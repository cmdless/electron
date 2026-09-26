import type { RpcProtocol, RpcPeer } from './protocol.js';

export type MaybePromise<T> = T | Promise<T>;

// The common shape for "start a transport server": a protocol to speak, an
// optional hook to register handlers on each accepted peer before it starts
// listening, and whatever options the underlying transport itself takes.
export type TransportParameters<P extends RpcProtocol, Options = unknown> = {
  protocol: P;
  configure?: (peer: RpcPeer<P['server']>) => void;
  options?: Options;
};