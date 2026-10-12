import { useEffect, useState } from 'react';
import type { SessionNotification } from '@agentclientprotocol/sdk';
import type { RpcPeer } from '@cmdless/rpc-sdk';
import { connectWebSocket } from '@cmdless/rpc-sdk/ws';
import { conversationProtocol } from '../../shared/protocols.js';

type ConversationPeer = RpcPeer<typeof conversationProtocol['client']>;

export default function Conversation() {
  const [rpc, setRpc] = useState<ConversationPeer>();
  const [updates, setUpdates] = useState<SessionNotification[]>([]);
  const [text, setText] = useState('');

  // not useRpc - node starts streaming (the initial prompt) the moment it
  // connects, so notification handlers have to be registered *before*
  // listen(), not reactively after state settles.
  useEffect(() => {
    let disposed = false;
    let peer: ConversationPeer | undefined;

    window.cmdless.ipc.request.connectionInfo().then(({ address }) => {
      if (!address || disposed) return;
      return connectWebSocket(conversationProtocol, { url: address }).then(connected => {
        if (disposed) { connected.dispose(); return; }
        peer = connected;
        connected.onNotification.update(notification => setUpdates(u => [...u, notification]));
        connected.onNotification.stop(() => { });
        connected.listen();
        setRpc(connected);
      });
    });

    return () => {
      disposed = true;
      peer?.dispose();
    };
  }, []);

  return (
    <div>
      <h1>Conversation</h1>
      <div style={{ whiteSpace: 'pre-wrap', border: '1px solid #ccc', padding: 8, minHeight: 200 }}>
        {updates.map((notification, i) => (
          <div key={i}>{JSON.stringify(notification.update)}</div>
        ))}
      </div>
      <textarea value={text} onChange={e => setText(e.target.value)} style={{ width: '100%' }} />
      <div>
        <button type="button" disabled={!text} onClick={() => {
          rpc?.request.sendPrompt({ text });
          setText('');
        }}>
          Send
        </button>
        <button type="button" onClick={() => {
          window.cmdless.ipc.notify.resolve({ value: null });
        }}>
          Done
        </button>
      </div>
    </div>
  );
}
