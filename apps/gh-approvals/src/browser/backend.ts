import { useEffect, useState } from 'react';
import type { ClientOf, ClientProtocol, StateSubscription } from '@cmdless/rpc-sdk';
import { connect } from '@cmdless/ui-sdk/browser';

// this window's backend, as a client of its protocol - once it's connected
export function useBackend<P extends ClientProtocol>(protocol: P) {
  const [client, setClient] = useState<ClientOf<P>>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let disposed = false;
    let connected: ClientOf<P> | undefined;
    connect(protocol).then(
      backend => {
        if (disposed) return backend.dispose();
        connected = backend;
        setClient(backend);
      },
      reason => setError(String(reason)),
    );
    return () => {
      disposed = true;
      connected?.dispose();
    };
  }, [protocol]);

  return { client, error };
}

// a state channel's latest value, for as long as the component is mounted
export function useChannel<T>(channel: StateSubscription<T> | undefined) {
  const [state, setState] = useState<T>();

  useEffect(() => {
    if (!channel) return;
    let stopped = false;
    let stop: (() => void) | undefined;
    void channel.subscribe(state => setState(state)).then(unsubscribe => {
      if (stopped) unsubscribe();
      else stop = unsubscribe;
    });
    return () => {
      stopped = true;
      stop?.();
    };
  }, [channel]);

  return state;
}
