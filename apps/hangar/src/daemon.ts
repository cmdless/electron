import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  createHost, listen, fileSessions, fileUsage, fileResources, shellTerminals,
  gitChanges, gitBranches, gitWorktrees, hostTools,
} from '@ahpd/sdk';
import type { Agent, Host, Peer } from '@ahpd/sdk';
import { claude } from '@ahpd/agent-claude';
import { acpAgent } from '@ahpd/agent-acp';
import { getAppDataPath, isPendingService, rejectService, resolveService } from '@cmdless/core/node';
import { startSocket } from '@cmdless/rpc-sdk/node';
import type { Accept } from '@cmdless/rpc-sdk';
import { connectHangar, getHangarSocketPath, hangarProtocol } from '@cmdless/hangar-sdk/node';
import type { HangarInfo, HangarService, RestartParams } from '@cmdless/hangar-sdk';

type HangarPeer = ReturnType<typeof hangarProtocol.createServer>;

const dataPath = getAppDataPath('hangar');

// the directories sessions may live in - hardcoded until hangar has its own
// configuration to read them from
const workspaces = [os.homedir()];

// hardcoded until hangar manages ahpd plugins. agent-acp's shipped presets
// only apply through its plugin loader, so these spell out the same command.
async function loadAgents(): Promise<Agent[]> {
  return [
    claude({ paths: workspaces }),
    acpAgent({ provider: 'copilot', displayName: 'Copilot', command: 'copilot', args: ['--acp'], env: { COPILOT_AUTO_UPDATE: 'false' } }),
    acpAgent({ provider: 'codex', displayName: 'Codex', command: 'npx', args: ['-y', '@agentclientprotocol/codex-acp'] }),
  ];
}

// one AHP host and every connection made to it. A restart throws the whole
// generation away: connections to the old host are closed so their clients
// reconnect, and land on the new one.
type Generation = {
  host: Host;
  instanceId: string;
  connections: Set<{ peer: Peer; close(): void }>;
};

async function createGeneration(): Promise<Generation> {
  const host = createHost({
    path: workspaces[0],
    agents: await loadAgents(),
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
  return { host, instanceId: crypto.randomUUID(), connections: new Set() };
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
  const clients = new Set<HangarPeer>();
  let generation: Generation | undefined;
  let ahpAddress = '';

  const info = (): HangarInfo => ({ pid: process.pid, instanceId: generation!.instanceId, ahpAddress });

  async function restart({ force }: RestartParams = {}) {
    const current = generation!;
    current.host.refuseTurns('hangar is restarting');
    const turning = current.host.turning();
    if (turning.length > 0 && !force) {
      current.host.refuseTurns(undefined);
      throw new Error(`${turning.length} session(s) have a turn running; restart with force to end them`);
    }

    await closeGeneration(current);
    generation = await createGeneration();

    for (const client of clients) {
      try { client.notify.restarted(info()); }
      catch { clients.delete(client); }
    }
    return info();
  }

  const { accept } = await hangarProtocol.defineHost({
    configure: peer => {
      clients.add(peer);
      peer.onRequest.info(() => info());
      peer.onRequest.restart(params => restart(params));
    },
  })();
  const lock = await bindLock(accept);

  const service: HangarService = { address: getHangarSocketPath() };

  // another daemon won the race to the lock - it lives at the same address,
  // so that's what this one hands back before leaving
  if (!lock) {
    if (isPendingService()) await resolveService(service);
    return;
  }

  generation = await createGeneration();

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
  ahpAddress = `ws://${listener.host}:${listener.port}`;

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
