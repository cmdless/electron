import { createCallback } from './connections.js';
import type { DataCallback } from './connections.js';

// two in-memory connections wired to each other, for tests that need a
// client and a server without a real transport
export function createLoopbackPair() {
  let clientCallback: DataCallback | undefined;
  let serverCallback: DataCallback | undefined;

  const clientConn = createCallback(
    { subscribe: callback => { clientCallback = callback; return () => { clientCallback = undefined; }; } },
    { send: message => serverCallback?.(message) },
  );
  const serverConn = createCallback(
    { subscribe: callback => { serverCallback = callback; return () => { serverCallback = undefined; }; } },
    { send: message => clientCallback?.(message) },
  );

  return { clientConn, serverConn };
}

export const tick = () => new Promise(resolve => setImmediate(resolve));
