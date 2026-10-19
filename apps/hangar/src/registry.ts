import type { RegistryAgent, RegistryState } from '@cmdless/hangar-sdk';

export const REGISTRY_URL = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json';

// fetches the published registry, keyed by agent id - the registry channel's
// file storage is what caches it
export async function fetchRegistry(): Promise<RegistryState> {
  const response = await fetch(REGISTRY_URL);
  if (!response.ok) throw new Error(`fetching the ACP registry failed: ${response.status} ${response.statusText}`);
  const { agents } = await response.json() as { agents: RegistryAgent[] };
  return {
    fetchedAt: new Date().toISOString(),
    agents: Object.fromEntries(agents.map(agent => [agent.id, agent])),
  };
}
