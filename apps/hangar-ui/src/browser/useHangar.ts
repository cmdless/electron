import { useEffect, useState } from 'react';
import type { ClientOf, StateSubscription } from '@cmdless/rpc-sdk';
import { connectWebSocket } from '@cmdless/rpc-sdk/ws';
import { hangarProtocol } from '@cmdless/hangar-sdk';
import { windowProtocol } from '../shared/protocols';

export type HangarClient = ClientOf<typeof hangarProtocol>;

// where hangar is: from the bin that opened this window, or - in a plain
// browser tab - from ?hangar=<webSocketAddress> on the page's URL
async function findHangar(): Promise<string> {
  const fromQuery = new URLSearchParams(window.location.search).get('hangar');
  if (fromQuery) return fromQuery;

  if (!window.cmdless)
    throw new Error('Not opened by hangar-ui, and no ?hangar=<address> given.');
  const { address } = await window.cmdless.ipc.request.connectionInfo();
  if (!address) throw new Error('The window that opened this one serves no connection.');
  const opener = await connectWebSocket(windowProtocol, { url: address });
  opener.listen();
  try {
    return (await opener.request.hangar()).url;
  } finally {
    opener.dispose();
  }
}

export function useHangar() {
  const [client, setClient] = useState<HangarClient>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let disposed = false;
    let connected: HangarClient | undefined;

    findHangar()
      .then(url => connectWebSocket(hangarProtocol, { url }))
      .then(async hangar => {
        if (disposed) { hangar.dispose(); return; }
        connected = hangar;
        hangar.listen();
        await hangar.checkVersion();
        setClient(hangar);
      })
      .catch(reason => setError(String(reason)));

    return () => {
      disposed = true;
      connected?.dispose();
    };
  }, []);

  return { client, error };
}

// a state channel's latest value, for as long as the component is mounted
export function useChannel<T>(channel: StateSubscription<T> | undefined) {
  const [state, setState] = useState<T>();

  useEffect(() => {
    if (!channel) return;
    let stopped = false;
    let stop: (() => void) | undefined;
    channel.subscribe(setState).then(unsubscribe => {
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
