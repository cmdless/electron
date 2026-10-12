import { useEffect, useState } from 'react';
import type { SessionModeState, SessionConfigOption, SessionConfigSelectOption } from '@agentclientprotocol/sdk';
import { defineGetProtocol } from '../../shared/protocols.js';
import { useRpc } from '../useRpc.js';

type Input = {
  modes: SessionModeState | null | undefined;
  configOptions: SessionConfigOption[] | null | undefined;
};

const protocol = defineGetProtocol<Input>();

export default function SessionConfig() {
  const rpc = useRpc(protocol);
  const [input, setInput] = useState<Input>();
  const [mode, setMode] = useState<string>();
  const [config, setConfig] = useState<Record<string, string | boolean>>({});

  useEffect(() => {
    rpc?.request.get().then(received => {
      setInput(received);
      setMode(received.modes?.currentModeId);
      setConfig(Object.fromEntries(
        (received.configOptions ?? []).map(option => [option.id, option.currentValue]),
      ));
    });
  }, [rpc]);

  if (!input) return <p>Loading…</p>;

  return (
    <div>
      <h1>Session options</h1>
      {input.modes && (
        <div>
          <label>Mode</label>{' '}
          <select value={mode} onChange={e => setMode(e.target.value)}>
            {input.modes.availableModes.map(m => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        </div>
      )}
      {(input.configOptions ?? []).map(option => (
        <div key={option.id}>
          <label>{option.name}</label>{' '}
          {option.type === 'boolean' ? (
            <input
              type="checkbox"
              checked={Boolean(config[option.id])}
              onChange={e => setConfig(c => ({ ...c, [option.id]: e.target.checked }))}
            />
          ) : (
            <select
              value={String(config[option.id] ?? '')}
              onChange={e => setConfig(c => ({ ...c, [option.id]: e.target.value }))}
            >
              {(option.options as (SessionConfigSelectOption | { group: string; options: SessionConfigSelectOption[] })[])
                .flatMap(entry => 'group' in entry ? entry.options : [entry])
                .map(choice => (
                  <option key={choice.value} value={choice.value}>{choice.name}</option>
                ))}
            </select>
          )}
          {option.description && <p>{option.description}</p>}
        </div>
      ))}
      <div>
        <button type="button" onClick={() => {
          window.cmdless.ipc.notify.resolve({ value: { mode, config } });
        }}>
          Apply
        </button>
        <button type="button" onClick={() => {
          window.cmdless.ipc.notify.resolve({ value: null });
        }}>
          Use defaults
        </button>
      </div>
    </div>
  );
}
