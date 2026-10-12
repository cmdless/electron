import { useEffect, useState } from 'react';
import type { RequestPermissionRequest } from '@agentclientprotocol/sdk';
import { defineGetProtocol } from '../../shared/protocols.js';
import { useRpc } from '../useRpc.js';

const protocol = defineGetProtocol<RequestPermissionRequest>();

export default function Permission() {
  const rpc = useRpc(protocol);
  const [request, setRequest] = useState<RequestPermissionRequest>();

  useEffect(() => {
    rpc?.request.get().then(setRequest);
  }, [rpc]);

  if (!request) return <p>Loading…</p>;

  return (
    <div>
      <h1>Permission requested</h1>
      <p>{request.toolCall.title ?? request.toolCall.toolCallId}</p>
      <ul>
        {request.options.map(option => (
          <li key={option.optionId}>
            <button type="button" onClick={() => {
              window.cmdless.ipc.notify.resolve({ value: { optionId: option.optionId } });
            }}>
              {option.name}
            </button>
          </li>
        ))}
      </ul>
      <button type="button" onClick={() => {
        window.cmdless.ipc.notify.resolve({ value: null });
      }}>
        Cancel
      </button>
    </div>
  );
}
