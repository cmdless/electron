import { defineProtocol } from '@cmdless/rpc-sdk';

// what the daemon resolves as a service: only where to reach it. Anything
// that can change while it runs comes from its state channels.
export type HangarService = {
  address: string;
};

export type HostState = {
  // the daemon process, stable for as long as the daemon lives
  pid: number;
  status: 'starting' | 'ready' | 'restarting';
  // changes every time the daemon (re)creates its AHP host - a client that
  // sees a new one knows its AHP connection is to a host that's gone
  instanceId: string;
  // where the AHP host is served, token included; the same across restarts
  ahpAddress: string;
  // hangar's own protocol over WebSocket, token included - for clients that
  // can't reach its local socket, like a browser
  webSocketAddress: string;
  // the agents changed since this host started, and a restart applies them
  stale: boolean;
  // agents the running host couldn't serve, and why
  unavailable: Record<string, string>;
  // where hangar keeps its data (agents.json, the registry cache, sessions)
  dataPath: string;
  // fetching the ACP registry: what's happening now, and the last failure
  registry: { status: 'idle' | 'refreshing' | 'error'; error?: string };
};

// an agent from the ACP registry, run through its npx or uvx distribution
export type AcpRegistryAgentEntry = {
  kind: 'acp-registry';
  id: string;
  registryId: string;
  // 'latest' follows the registry; anything else pins the package version
  version: 'latest' | (string & {});
};

// any ACP agent, run as a raw command
export type CustomAgentEntry = {
  kind: 'custom';
  id: string;
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

export type AgentEntry = AcpRegistryAgentEntry | CustomAgentEntry;

// agents.json: every configured agent, by id. Claude is built in, and served
// whatever this says.
export type AgentsState = Record<string, AgentEntry>;

type Distribution = {
  npx?: { package: string; args?: string[]; env?: Record<string, string> };
  uvx?: { package: string; args?: string[]; env?: Record<string, string> };
  binary?: Record<string, { archive: string; sha256?: string; cmd: string; args?: string[]; env?: Record<string, string> }>;
};

// one entry of https://agentclientprotocol.com/registry, as published
export type RegistryAgent = {
  id: string;
  name: string;
  version: string;
  description?: string;
  repository?: string;
  website?: string;
  icon?: string;
  distribution: Distribution;
};

// the last fetch of the ACP registry, as cached in acp-registry.json
export type RegistryState = {
  fetchedAt?: string;
  agents: Record<string, RegistryAgent>;
};

// trust.json: the folders agents may be started in, as absolute paths - a
// folder's subfolders are trusted with it. ahpd asks every client for this
// on its own connection, so each UI pushes the same list when it connects.
export type TrustState = {
  folders: string[];
};

export type RestartParams = {
  // restart even while a turn is running, ending it
  force?: boolean;
};

export const hangarProtocol = defineProtocol(({ side, request, state }) => ({
  // bump only for a change that breaks clients - adding things doesn't
  name: 'hangar',
  version: 1,
  clientToServer: side({
    requests: {
      restart: request<RestartParams, void>('host/restart'),
      // adds or replaces an entry, by its id
      setAgent: request<{ entry: AgentEntry }, void>('agents/set'),
      removeAgent: request<{ id: string }, void>('agents/remove'),
      refreshRegistry: request<void, void>('registry/refresh'),
      trustFolder: request<{ path: string }, void>('trust/add'),
      untrustFolder: request<{ path: string }, void>('trust/remove'),
      // adds every project Codex's config.toml marks trusted, and says which
      // were new
      importCodexTrust: request<void, { added: string[] }>('trust/importCodex'),
    },
  }),
  state: {
    host: state<HostState>('host'),
    agents: state<AgentsState>('agents'),
    registry: state<RegistryState>('registry'),
    trust: state<TrustState>('trust'),
  },
}));
