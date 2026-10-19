import type { AcpOptions } from '@ahpd/agent-acp';
import type { AgentEntry, AgentsState, RegistryAgent } from '@cmdless/hangar-sdk';

// what agents.json starts as
export const defaultAgents: AgentsState = {
  copilot: { kind: 'acp-registry', id: 'copilot', registryId: 'github-copilot-cli', version: 'latest' },
  codex: { kind: 'acp-registry', id: 'codex', registryId: 'codex-acp', version: 'latest' },
};

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

// what a client sent, checked before it reaches agents.json
export function validEntry(entry: AgentEntry): AgentEntry {
  if (!entry?.id) throw new Error('an agent entry needs an id');
  if (entry.kind === 'acp-registry' && entry.registryId) return { ...entry, version: entry.version || 'latest' };
  if (entry.kind === 'custom' && entry.name && entry.command) return entry;
  throw new Error(`not a valid agent entry: ${JSON.stringify(entry)}`);
}
