// the big three: each is an ACP-compatible subprocess spoken to over stdio
// via the same generic @agentclientprotocol/sdk client - only the package
// to spawn (and, for copilot, the flag needed to put it into ACP mode)
// differs per agent. claude/codex's packages are ACP-only already.
// Plain data, shared with the browser side so PickAgent can list the same
// choices node actually resolves against.
export const ACP_AGENTS = [
  { id: 'claude', name: 'Claude Code', packageName: '@agentclientprotocol/claude-agent-acp', args: [] as string[] },
  { id: 'codex', name: 'Codex', packageName: '@agentclientprotocol/codex-acp', args: [] as string[] },
  { id: 'copilot', name: 'GitHub Copilot CLI', packageName: '@github/copilot', args: ['--acp'] },
] as const;

export type AcpAgentId = typeof ACP_AGENTS[number]['id'];
