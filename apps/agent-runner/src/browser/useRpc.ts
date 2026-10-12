import { useEffect, useState } from 'react';
import type { RpcProtocol, RpcPeer } from '@cmdless/rpc-sdk';
import { connectWebSocket } from '@cmdless/rpc-sdk/ws';

// the live per-invocation channel a picker's node side stood up via
// createShowCommand's `transport` (see node/ui.ts/acp.ts) - its address
// comes back over the always-on cmdlessIPC connectionInfo request.
export function useRpc<P extends RpcProtocol>(protocol: P) {
  const [rpc, setRpc] = useState<RpcPeer<P['client']>>();

  useEffect(() => {
    let disposed = false;
    let peer: RpcPeer<P['client']> | undefined;

    window.cmdless.ipc.request.connectionInfo().then(({ address }) => {
      if (!address || disposed) return;
      return connectWebSocket(protocol, { url: address }).then(connected => {
        if (disposed) { connected.dispose(); return; }
        peer = connected;
        connected.listen();
        setRpc(connected);
      });
    });

    return () => {
      disposed = true;
      peer?.dispose();
    };
  }, [protocol]);

  return rpc;
}
