import { useEffect, useState } from 'react';
import { chatReducer, rootReducer, sessionReducer, SUPPORTED_PROTOCOL_VERSIONS } from '@microsoft/agent-host-protocol';
import type {
  ChatAction, ChatState, ModelSelection, RootAction, RootState, SessionAction, SessionState, SessionSummary, StateAction, URI,
} from '@microsoft/agent-host-protocol';
import { AhpClient } from '@microsoft/agent-host-protocol/client';
import { WebSocketTransport } from '@microsoft/agent-host-protocol/ws';
import { useHangarClient } from './hangar';
import { useChannel } from './useHangar';

export const ROOT = 'ahp-root://';

export type Ahp = {
  client: AhpClient;
  clientId: string;
  root: RootState;
  // every session the host lists, by resource
  sessions: Record<URI, SessionSummary>;
};

async function listAllSessions(client: AhpClient) {
  const sessions: Record<URI, SessionSummary> = {};
  let cursor: string | undefined;
  do {
    const page = await client.request('listSessions', { channel: ROOT, cursor });
    for (const summary of page.items) sessions[summary.resource] = summary;
    cursor = page.nextCursor;
  } while (cursor);
  return sessions;
}

// a connection to hangar's AHP host: the root state and the session list,
// kept current. It reconnects whenever hangar's host restarts (a new
// instanceId), since the old host's sessions and subscriptions are gone.
export function useAhp() {
  const hangar = useHangarClient();
  const host = useChannel(hangar.state.host);
  const [ahp, setAhp] = useState<Ahp>();
  const [error, setError] = useState<string>();

  const address = host?.status === 'ready' ? host.ahpAddress : undefined;
  const instance = host?.instanceId;

  useEffect(() => {
    if (!address) return;
    let closed = false;
    let client: AhpClient | undefined;
    setAhp(undefined);
    setError(undefined);

    (async () => {
      client = new AhpClient(await WebSocketTransport.connect(address));
      if (closed) return void client.shutdown();
      client.connect();
      const clientId = `hangar-ui-${crypto.randomUUID()}`;
      const init = await client.initialize({
        clientId,
        protocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
        initialSubscriptions: [ROOT],
      });
      let root = init.snapshots.find(snapshot => snapshot.resource === ROOT)?.state as RootState;
      let sessions = await listAllSessions(client);
      if (closed) return;
      const update = () => setAhp({ client: client!, clientId, root, sessions });
      update();

      for await (const event of client.attachSubscription(ROOT)) {
        if (closed) break;
        if (event.type === 'action') root = rootReducer(root, event.params.action as RootAction);
        else if (event.type === 'sessionAdded') sessions = { ...sessions, [event.params.summary.resource]: event.params.summary };
        else if (event.type === 'sessionRemoved') {
          const { [event.params.session]: _, ...rest } = sessions;
          sessions = rest;
        } else if (event.type === 'sessionSummaryChanged') {
          const current = sessions[event.params.session];
          if (current) sessions = { ...sessions, [event.params.session]: { ...current, ...event.params.changes } };
        } else continue;
        update();
      }
    })().catch(reason => { if (!closed) setError(String(reason?.message ?? reason)); });

    return () => {
      closed = true;
      void client?.shutdown();
    };
  }, [address, instance]);

  return { ahp, error };
}

// one channel's state from its snapshot, folded forward through its actions
// with the protocol's own reducer, for as long as the component is mounted
export function useAhpChannel<S, A>(client: AhpClient | undefined, uri: URI | undefined, reduce: (state: S, action: A) => S) {
  // kept with the client and channel it came from, so a component that moves
  // to another channel - or none - never shows the last one's state
  const [held, setHeld] = useState<{ client: AhpClient; uri: URI; state: S }>();

  useEffect(() => {
    if (!client || !uri) return;
    let closed = false;

    (async () => {
      const { result, subscription } = await client.subscribe(uri);
      let current = result.snapshot?.state as S;
      if (closed) return void client.unsubscribe(uri).catch(() => { });
      setHeld({ client, uri, state: current });
      for await (const event of subscription) {
        if (closed) break;
        if (event.type !== 'action') continue;
        current = reduce(current, event.params.action as A);
        setHeld({ client, uri, state: current });
      }
    })().catch(() => { });

    return () => {
      closed = true;
      void client.unsubscribe(uri).catch(() => { });
    };
  }, [client, uri, reduce]);

  return held && held.client === client && held.uri === uri ? held.state : undefined;
}

export const useChat = (client: AhpClient | undefined, uri: URI | undefined) =>
  useAhpChannel<ChatState, ChatAction>(client, uri, chatReducer as (state: ChatState, action: ChatAction) => ChatState);

// a new session, named the way ahpd holds it - `<provider>:/<id>` - so it
// matches the name the session list will carry. The creator joins it as an
// active client, which is what lets it start turns.
export async function createSession(ahp: Ahp, provider: string, folder?: string) {
  const channel = `${provider}:/${crypto.randomUUID()}`;
  await ahp.client.request('createSession', {
    channel,
    provider,
    ...(folder ? { workingDirectories: [`file://${folder}`] } : {}),
    activeClient: { clientId: ahp.clientId, displayName: 'Hangar UI', tools: [] },
  });
  return channel;
}

// the protocol's action types are const enums, so actions are written with
// their string values and cast
const dispatch = (ahp: Ahp, channel: URI, action: object) => ahp.client.dispatch(channel, action as StateAction);

export function sendMessage(ahp: Ahp, chat: URI, text: string, model?: ModelSelection) {
  dispatch(ahp, chat, {
    type: 'chat/turnStarted',
    turnId: crypto.randomUUID(),
    startedAt: new Date().toISOString(),
    message: { text, origin: { kind: 'user' }, ...(model ? { model } : {}) },
  });
}

export const cancelTurn = (ahp: Ahp, chat: URI, turnId: string) =>
  dispatch(ahp, chat, { type: 'chat/turnCancelled', turnId });

export const setSessionConfig = (ahp: Ahp, session: URI, config: Record<string, unknown>) =>
  dispatch(ahp, session, { type: 'session/configChanged', config });

// subscribing to a session is also what opens it - a session listed from an
// agent's own files is loaded, turns and all, when something subscribes
export const useSession = (client: AhpClient | undefined, uri: URI | undefined) =>
  useAhpChannel<SessionState, SessionAction>(client, uri, sessionReducer as (state: SessionState, action: SessionAction) => SessionState);
