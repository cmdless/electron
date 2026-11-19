import { defineProtocol } from '@cmdless/rpc-sdk';

// the log viewer's window: the file it shows, and its last lines - kept up
// to date by the tray as the file grows
export type LogState = { file: string; lines: string[] };

export const logProtocol = defineProtocol(({ state }) => ({
  name: 'gh-approvals/log',
  state: { log: state<LogState>('log') },
}));
