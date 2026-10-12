import { useEffect, useState } from 'react';
import type { CreateElicitationRequest, ElicitationContentValue, ElicitationFormMode } from '@agentclientprotocol/sdk';
import { defineGetProtocol } from '../../shared/protocols.js';
import { useRpc } from '../useRpc.js';

const protocol = defineGetProtocol<CreateElicitationRequest>();

export default function Elicitation() {
  const rpc = useRpc(protocol);
  const [request, setRequest] = useState<CreateElicitationRequest>();
  const [values, setValues] = useState<Record<string, ElicitationContentValue>>({});

  useEffect(() => {
    rpc?.request.get().then(setRequest);
  }, [rpc]);

  if (!request) return <p>Loading…</p>;
  // url mode never reaches this window (acp.ts declines it before showing
  // one), but the type still allows it - kept as a visible fallback.
  if (request.mode !== 'form') return <p>Unsupported elicitation mode: {request.mode}</p>;

  // the real union's third ("custom future mode") member has a `[key:
  // string]: unknown` index signature, which stops `mode !== 'form'` from
  // narrowing requestedSchema/message cleanly above - cast explicitly
  // instead of fighting that.
  const form = request as CreateElicitationRequest & ElicitationFormMode & { message: string };
  const { requestedSchema } = form;
  // same custom/catch-all-variant narrowing issue as CreateElicitationRequest
  // above, one level down - ElicitationPropertySchema's union has the same
  // `[key: string]: unknown` escape hatch, so property access on it
  // collapses to `unknown` without a cast.
  const properties = Object.entries(requestedSchema.properties ?? {}) as [
    string,
    { type?: string; title?: string | null; description?: string | null },
  ][];

  return (
    <div>
      <h1>{requestedSchema.title ?? 'Input requested'}</h1>
      <p>{form.message}</p>
      {requestedSchema.description && <p>{requestedSchema.description}</p>}
      {properties.map(([key, property]) => (
        <div key={key}>
          <label>
            {property.title ?? key}{' '}
            {property.type === 'boolean' ? (
              <input
                type="checkbox"
                checked={Boolean(values[key])}
                onChange={e => setValues(v => ({ ...v, [key]: e.target.checked }))}
              />
            ) : (
              <input
                type={property.type === 'number' || property.type === 'integer' ? 'number' : 'text'}
                value={(values[key] as string | number | undefined) ?? ''}
                onChange={e => setValues(v => ({
                  ...v,
                  [key]: property.type === 'number' || property.type === 'integer' ? e.target.valueAsNumber : e.target.value,
                }))}
              />
            )}
          </label>
          {property.description && <p>{property.description}</p>}
        </div>
      ))}
      <div>
        <button type="button" onClick={() => {
          window.cmdless.ipc.notify.resolve({ value: { action: 'accept', content: values } });
        }}>
          Submit
        </button>
        <button type="button" onClick={() => {
          window.cmdless.ipc.notify.resolve({ value: { action: 'decline' } });
        }}>
          Decline
        </button>
      </div>
    </div>
  );
}
