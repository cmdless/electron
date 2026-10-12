import { ACP_AGENTS } from '../../shared/agents.js';

export default function PickAgent() {
  return (
    <div>
      <h1>Pick an agent</h1>
      <ul>
        {ACP_AGENTS.map(agent => (
          <li key={agent.id}>
            <button type="button" onClick={() => {
              window.cmdless.ipc.notify.resolve({ value: { agent: agent.id } });
            }}>
              {agent.name}
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
