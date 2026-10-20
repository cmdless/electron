import { useState } from 'react';
import type { AgentEntry, RegistryAgent } from '@cmdless/hangar-sdk';
import { useChannel, useHangar } from '../useHangar';
import type { HangarClient } from '../useHangar';

// what a registry agent can run as - hangar runs npx and uvx, not binaries yet
function runsAs(agent: RegistryAgent) {
  if (agent.distribution.npx) return 'npx';
  if (agent.distribution.uvx) return 'uvx';
  return undefined;
}

function useAction() {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const run = (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    action().catch(reason => setError(String(reason?.message ?? reason))).finally(() => setBusy(false));
  };
  return { run, busy, error };
}

function Host({ hangar }: { hangar: HangarClient }) {
  const host = useChannel(hangar.state.host);
  const { run, busy, error } = useAction();
  if (!host) return null;

  return (
    <header className="host">
      <div>
        <strong>hangar</strong> <span className={`status ${host.status}`}>{host.status}</span>
        <span className="muted"> · {host.dataPath}</span>
      </div>
      {host.stale && (
        <div className="banner">
          Agents changed since the host started.
          <button disabled={busy} onClick={() => run(() => hangar.request.restart({}))}>Restart to apply</button>
          {error && <button disabled={busy} onClick={() => run(() => hangar.request.restart({ force: true }))}>Restart anyway</button>}
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </header>
  );
}

function Configured({ hangar }: { hangar: HangarClient }) {
  const agents = useChannel(hangar.state.agents);
  const registry = useChannel(hangar.state.registry);
  const host = useChannel(hangar.state.host);
  const { run, busy, error } = useAction();

  const describe = (entry: AgentEntry) => entry.kind === 'custom'
    ? `${entry.name} · ${entry.command} ${(entry.args ?? []).join(' ')}`
    : `${registry?.agents[entry.registryId]?.name ?? entry.registryId} · ${entry.registryId}@${entry.version}`;

  return (
    <section>
      <h2>Agents</h2>
      <ul className="list">
        <li><span>Claude <span className="muted">· built in</span></span></li>
        {Object.values(agents ?? {}).map(entry => (
          <li key={entry.id}>
            <span>
              {describe(entry)}
              {host?.unavailable[entry.id] && <span className="error"> · {host.unavailable[entry.id]}</span>}
            </span>
            <button disabled={busy} onClick={() => run(() => hangar.request.removeAgent({ id: entry.id }))}>Remove</button>
          </li>
        ))}
      </ul>
      {error && <p className="error">{error}</p>}
    </section>
  );
}

function Registry({ hangar }: { hangar: HangarClient }) {
  const registry = useChannel(hangar.state.registry);
  const agents = useChannel(hangar.state.agents);
  const host = useChannel(hangar.state.host);
  const { run, busy, error } = useAction();

  const added = new Set(Object.values(agents ?? {}).flatMap(entry => entry.kind === 'acp-registry' ? [entry.registryId] : []));
  const status = host?.registry;

  return (
    <section>
      <h2>
        ACP registry
        <button disabled={busy || status?.status === 'refreshing'} onClick={() => run(() => hangar.request.refreshRegistry())}>
          {status?.status === 'refreshing' ? 'Refreshing…' : 'Refresh'}
        </button>
      </h2>
      <p className="muted">
        {registry?.fetchedAt ? `Fetched ${new Date(registry.fetchedAt).toLocaleString()}` : 'Not fetched yet'}
        {status?.status === 'error' && <span className="error"> · {status.error}</span>}
      </p>
      <div className="cards">
        {Object.values(registry?.agents ?? {}).sort((a, b) => a.name.localeCompare(b.name)).map(agent => {
          const via = runsAs(agent);
          return (
            <article key={agent.id} className="card">
              <header>
                {agent.icon && <img src={agent.icon} alt="" />}
                <strong>{agent.name}</strong>
                <span className="muted">{agent.version}</span>
              </header>
              <p>{agent.description}</p>
              <footer>
                <span className="muted">{via ?? 'binary only'}</span>
                <button
                  disabled={busy || added.has(agent.id) || !via}
                  onClick={() => run(() => hangar.request.setAgent({
                    entry: { kind: 'acp-registry', id: agent.id, registryId: agent.id, version: 'latest' },
                  }))}
                >
                  {added.has(agent.id) ? 'Added' : 'Add'}
                </button>
              </footer>
            </article>
          );
        })}
      </div>
      {error && <p className="error">{error}</p>}
    </section>
  );
}

export default function Agents() {
  const { client, error } = useHangar();
  if (error) return <p className="error">{error}</p>;
  if (!client) return <p className="muted">Connecting to hangar…</p>;

  return (
    <main>
      <Host hangar={client} />
      <Configured hangar={client} />
      <Registry hangar={client} />
    </main>
  );
}
