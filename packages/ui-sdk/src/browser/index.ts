import { createSocketConnection } from '@cmdless/rpc-sdk/ws';
import type { ClientOf, ClientProtocol } from '@cmdless/rpc-sdk';
import type { Cmdless, CmdlessSocket } from '../index.js';

export type { Cmdless, CmdlessSocket };

// kept inline (rather than a separate env.d.ts) so it's guaranteed to ship
// with dist/browser/index.d.ts - a standalone ambient .d.ts isn't pulled
// into a consumer's compilation just by their importing this module, since
// tsc doesn't emit/copy a source file that's already a .d.ts on its own.
declare global {
  interface Window {
    cmdless: Cmdless;
  }
}

// connects this window to the backend it was opened with - the node side
// that opened it, straight to it once the host has introduced them. configure
// sets up handlers before the connection listens, so nothing the backend
// sends right away is missed. A protocol with a name and version can be held
// to them with checkVersion() once connected.
export async function connect<P extends ClientProtocol>(
  protocol: P,
  configure?: (backend: ClientOf<P>) => void,
): Promise<ClientOf<P>> {
  if (!window.cmdless) throw new Error('not in a cmdless window');
  const socket = await window.cmdless.connect();
  const backend = protocol.createClient(createSocketConnection({
    send: message => socket.send(message),
    onMessage: listener => socket.onMessage(listener),
    onError: () => { },
    onClose: listener => socket.onClose(listener),
    dispose: () => socket.close(),
  })) as ClientOf<P>;
  configure?.(backend);
  backend.listen();
  return backend;
}
