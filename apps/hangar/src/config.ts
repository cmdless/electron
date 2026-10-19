import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentEntry } from '@cmdless/hangar-sdk';

export type HangarConfig = {
  // what a change to the agents does: restart the host to apply it, or mark
  // the host stale for a UI to offer the restart (a running turn always
  // falls back to stale, so a change never cuts one off)
  onAgentsChange: 'stale' | 'restart';
  // the directories sessions may live in; the first is the default
  workspaces: string[];
  agents: Record<string, AgentEntry>;
};

const defaults: HangarConfig = {
  onAgentsChange: 'stale',
  workspaces: ['~'],
  agents: {
    copilot: { kind: 'acp-registry', id: 'copilot', registryId: 'github-copilot-cli', version: 'latest' },
    codex: { kind: 'acp-registry', id: 'codex', registryId: 'codex-acp', version: 'latest' },
  },
};

const configFile = (dataPath: string) => path.join(dataPath, 'config.json');

export function expandHome(dir: string) {
  return dir === '~' || dir.startsWith('~/') ? path.join(os.homedir(), dir.slice(1)) : dir;
}

// reads config.json, filling in whatever it leaves out - and writes the
// defaults out on the first run, so there's a file to find and edit
export function loadConfig(dataPath: string): HangarConfig {
  const file = configFile(dataPath);
  if (!fs.existsSync(file)) {
    saveConfig(dataPath, defaults);
    return structuredClone(defaults);
  }
  const read = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<HangarConfig>;
  return { ...structuredClone(defaults), ...read };
}

export function saveConfig(dataPath: string, config: HangarConfig) {
  const file = configFile(dataPath);
  fs.mkdirSync(dataPath, { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(config, null, 2) + '\n');
  fs.renameSync(temp, file);
}
