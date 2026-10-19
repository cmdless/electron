import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  createHost, listen, fileSessions, fileUsage, fileResources, shellTerminals,
  gitChanges, gitBranches, gitWorktrees, hostTools,
} from '@ahpd/sdk';
import type { Host, Peer } from '@ahpd/sdk';
import { claude } from '@ahpd/agent-claude';
import { acpAgent } from '@ahpd/agent-acp';
import type { AcpOptions } from '@ahpd/agent-acp';
import { getAppDataPath, isPendingService, rejectService, resolveService } from '@cmdless/core/node';
import { memory } from '@cmdless/rpc-sdk';
import type { Accept } from '@cmdless/rpc-sdk';
import { file, startSocket } from '@cmdless/rpc-sdk/node';
import { connectHangar, getHangarSocketPath, hangarProtocol } from '@cmdless/hangar-sdk/node';
import type { AgentsState, HangarService, RegistryAgent, RestartParams } from '@cmdless/hangar-sdk';
import { defaultAgents, resolveAgent, validEntry } from './agents.js';
import { fetchRegistry } from './registry.js';

const dataPath = getAppDataPath('hangar');

// hangar's own options - constants until something needs to set them
const options = {
  // what a change to the agents (or a registry refresh that changes what
  // they resolve to) does: restart the host to apply it, or mark the host
  // stale for a UI to offer the restart. A running turn always falls back
  // to stale, so a change never cuts one off.
  onAgentsChange: 'stale' as 'stale' | 'restart',
  // the directories sessions may live in; the first is the default
  workspaces: [os.homedir()],
};

// what a host is built from: every agent that can run, why the rest can't,
// and a signature to tell whether a later config or registry would build a
// different one
function resolveAgents(entries: AgentsState, registry: Record<string, RegistryAgent>) {
  const agents: AcpOptions[] = [];
  const unavailable: Record<string, string> = {};
  for (const entry of Object.values(entries)) {
    const resolved = resolveAgent(entry, registry);
    if ('error' in resolved) unavailable[entry.id] = resolved.error;
    else agents.push(resolved);
  }
  const { workspaces } = options;
  return { agents, unavailable, workspaces, signature: JSON.stringify({ agents, workspaces }) };
}

// one AHP host and every connection made to it. A restart throws the whole
// generation away: connections to the old host are closed so their clients
// reconnect, and land on the new one.
type Generation = {
  host: Host;
  instanceId: string;
  signature: string;
  unavailable: Record<string, string>;
  connections: Set<{ peer: Peer; close(): void }>;
};

function createGeneration(resolved: ReturnType<typeof resolveAgents>): Generation {
  const { agents, unavailable, workspaces, signature } = resolved;
  const host = createHost({
    path: workspaces[0],
    agents: [claude({ paths: workspaces }), ...agents.map(acpAgent)],
    sessions: fileSessions({ dir: path.join(dataPath, 'sessions') }),
    usage: fileUsage({ folder: path.join(dataPath, 'usage') }),
    worktreesRoot: path.join(dataPath, 'worktrees'),
    resources: fileResources(),
    terminals: shellTerminals(),
    changes: gitChanges(),
    directories: gitBranches(),
    worktrees: gitWorktrees(),
    tools: hostTools(),
  });
  return { host, instanceId: crypto.randomUUID(), signature, unavailable, connections: new Set() };
}

async function closeGeneration({ host, connections }: Generation) {
  for (const connection of connections) {
    connection.close();
    connection.peer.close();
  }
  connections.clear();
  await host.close();
}

// binds the lock socket, or answers whether another daemon already holds
// it. A Unix socket outlives a crashed daemon as a file nothing listens on,
// so a refused connection means it's stale and safe to replace - a named
// pipe on Windows goes away with its process, so it's never stale.
async function bindLock(accept: Accept): Promise<net.Server | undefined> {
  const path = getHangarSocketPath();
  try {
    return await startSocket({ accept, options: { path } });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
  }

  try {
    (await connectHangar()).dispose();
    return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ECONNREFUSED') throw error;
  }

  fs.rmSync(path, { force: true });
  return startSocket({ accept, options: { path } });
}

async function main() {
  let generation: Generation | undefined;

  const createHangarHost = hangarProtocol.defineHost({
    state: {
      host: memory({
        pid: process.pid, status: 'starting', instanceId: '', ahpAddress: '',
        stale: false, unavailable: {}, dataPath, registry: { status: 'idle' },
      }),
      agents: file(path.join(dataPath, 'agents.json'), { default: defaultAgents }),
      registry: file(path.join(dataPath, 'acp-registry.json'), { default: { agents: {} } }),
    },
    configure: server => {
      server.onRequest.restart(params => restart(params));
      server.onRequest.setAgent(async ({ entry }) => {
        const valid = validEntry(entry);
        await store.update('agents', agents => { agents[valid.id] = valid; });
        await reconcile();
      });
      server.onRequest.removeAgent(async ({ id }) => {
        await store.update('agents', agents => { delete agents[id]; });
        await reconcile();
      });
      server.onRequest.refreshRegistry(() => refreshRegistry());
    },
  });
  const { store, accept } = await createHangarHost();

  const resolveCurrent = () => resolveAgents(store.state.agents, store.state.registry.agents);

  async function restart({ force }: RestartParams = {}) {
    const current = generation!;
    if (store.state.host.status !== 'ready') throw new Error(`hangar is ${store.state.host.status}`);
    current.host.refuseTurns('hangar is restarting');
    const turning = current.host.turning();
    if (turning.length > 0 && !force) {
      current.host.refuseTurns(undefined);
      throw new Error(`${turning.length} session(s) have a turn running; restart with force to end them`);
    }

    void store.update('host', host => { host.status = 'restarting'; });
    await closeGeneration(current);
    generation = createGeneration(resolveCurrent());
    const { instanceId, unavailable } = generation;
    void store.update('host', host => Object.assign(host, { status: 'ready', instanceId, unavailable, stale: false }));
  }

  // marks the host stale when the agents or registry would now build a
  // different one - and, when configured to, restarts it. A running turn
  // refuses the restart, which leaves it stale for later.
  async function reconcile() {
    if (!generation) return;
    const stale = resolveCurrent().signature !== generation.signature;
    void store.update('host', host => { host.stale = stale; });
    if (stale && options.onAgentsChange === 'restart')
      await restart().catch(error => console.error('hangar: restart deferred:', error));
  }

  // fetched out of band and set whole: the registry channel's file storage
  // caches it, and subscribers get the patch
  let refreshing: Promise<void> | undefined;
  function refreshRegistry() {
    refreshing ??= (async () => {
      void store.update('host', host => { host.registry = { status: 'refreshing' }; });
      try {
        await store.set({ registry: await fetchRegistry() });
        void store.update('host', host => { host.registry = { status: 'idle' }; });
      } catch (error) {
        void store.update('host', host => { host.registry = { status: 'error', error: String(error) }; });
      }
      await reconcile();
    })().finally(() => { refreshing = undefined; });
    return refreshing;
  }

  const lock = await bindLock(accept);
  const service: HangarService = { address: getHangarSocketPath() };

  // another daemon won the race to the lock - it lives at the same address,
  // so that's what this one hands back before leaving
  if (!lock) {
    if (isPendingService()) await resolveService(service);
    return;
  }

  // the first run has no cached registry, and registry agents can't resolve
  // without one - so that run waits for it, while any later run starts from
  // the cache and refreshes behind
  const firstRun = !store.state.registry.fetchedAt;
  const refreshed = refreshRegistry();
  if (firstRun) await refreshed;

  generation = createGeneration(resolveCurrent());

  // the address stays put across restarts: only the host behind it changes
  const listener = await listen({ port: 0, host: '127.0.0.1' }, (peer, principal, root) => {
    const current = generation!;
    const accepted = current.host.accept(peer, principal, root);
    const connection = { peer, close: accepted.close };
    current.connections.add(connection);
    return {
      handle: request => accepted.handle(request),
      close: () => {
        current.connections.delete(connection);
        accepted.close();
      },
    };
  });

  const { instanceId, unavailable } = generation;
  void store.update('host', host => Object.assign(host, {
    status: 'ready', instanceId, unavailable, ahpAddress: `ws://${listener.host}:${listener.port}`,
  }));

  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    if (generation) await closeGeneration(generation);
    await listener.close();
    lock!.close();
    process.exit(0);
  }
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  if (isPendingService()) await resolveService(service);
}

main().catch(async error => {
  console.error(error);
  if (isPendingService()) await rejectService(error).catch(() => { });
  process.exit(1);
});
