import fs from 'node:fs';
import path from 'node:path';
import type { AcpOptions } from '@ahpd/agent-acp';
import type { AgentEntry, RegistryAgent, RegistryState } from '@cmdless/hangar-sdk';

export const REGISTRY_URL = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json';

const cacheFile = (dataPath: string) => path.join(dataPath, 'acp-registry.json');

type Cache = { fetchedAt: string; agents: Record<string, RegistryAgent> };

export function loadRegistryCache(dataPath: string): RegistryState {
  try {
    const { fetchedAt, agents } = JSON.parse(fs.readFileSync(cacheFile(dataPath), 'utf8')) as Cache;
    return { status: 'cached', fetchedAt, agents };
  } catch {
    return { status: 'empty', agents: {} };
  }
}

// fetches the published registry and caches it, keyed by agent id
export async function fetchRegistry(dataPath: string): Promise<Cache> {
  const response = await fetch(REGISTRY_URL);
  if (!response.ok) throw new Error(`fetching the ACP registry failed: ${response.status} ${response.statusText}`);
  const { agents } = await response.json() as { agents: RegistryAgent[] };
  const cache: Cache = {
    fetchedAt: new Date().toISOString(),
    agents: Object.fromEntries(agents.map(agent => [agent.id, agent])),
  };
  fs.mkdirSync(dataPath, { recursive: true });
  fs.writeFileSync(cacheFile(dataPath), JSON.stringify(cache) + '\n');
  return cache;
}

// "@scope/name@1.2.3" with its version swapped for another
function pinPackage(spec: string, version: string) {
  const at = spec.lastIndexOf('@');
  const name = at > 0 ? spec.slice(0, at) : spec;
  return `${name}@${version}`;
}

// what agent-acp needs to run an entry, or why it can't be run
export function resolveAgent(entry: AgentEntry, registry: Record<string, RegistryAgent>): AcpOptions | { error: string } {
  if (entry.kind === 'custom')
    return { provider: entry.id, displayName: entry.name, command: entry.command, args: entry.args, env: entry.env };

  const agent = registry[entry.registryId];
  if (!agent) return { error: `${entry.registryId} isn't in the ACP registry (or the registry hasn't been fetched yet)` };

  const pin = (spec: string) => entry.version === 'latest' ? spec : pinPackage(spec, entry.version);
  const base = { provider: entry.id, displayName: agent.name, description: agent.description };
  const { npx, uvx } = agent.distribution;
  if (npx) return { ...base, command: 'npx', args: ['-y', pin(npx.package), ...(npx.args ?? [])], env: npx.env };
  if (uvx) return { ...base, command: 'uvx', args: [pin(uvx.package), ...(uvx.args ?? [])], env: uvx.env };
  return { error: `${entry.registryId} is only distributed as a binary, which hangar can't run yet` };
}
