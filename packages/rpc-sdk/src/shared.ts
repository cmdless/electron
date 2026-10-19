import type { MessageConnection } from 'vscode-jsonrpc';

export type MaybePromise<T> = T | Promise<T>;

// what a transport hands each new connection to: something that turns it
// into a configured peer (a host's accept, usually), which the transport
// then starts listening
export type Accept<T extends { listen: () => void } = { listen: () => void }> =
  (connection: MessageConnection) => T;

// The common shape for "start a transport server": what to hand each
// accepted connection to, and whatever options the underlying transport
// itself takes.
export type TransportParameters<Options = unknown, T extends { listen: () => void } = { listen: () => void }> = {
  accept: Accept<T>;
  options?: Options;
};
