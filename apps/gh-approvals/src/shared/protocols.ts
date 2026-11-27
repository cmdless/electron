import { defineProtocol } from '@cmdless/rpc-sdk';
import type { Items } from './items.js';

// the log viewer's window: the file it shows, and its last lines - kept up
// to date by the tray as the file grows
export type LogState = { file: string; lines: string[] };

export const logProtocol = defineProtocol(({ state }) => ({
  name: 'gh-approvals/log',
  state: { log: state<LogState>('log') },
}));

// every tray this one is connected to, and its own, by device: whose it is,
// and its items as that tray serves them - each one's changes passed on as
// they come
export type Device = { user: string; items: Items };
export type Devices = Record<string, Device>;

// this tray: which device it is, and whether it's online with the others
export type ApprovalsStatus = { deviceId: string; online: boolean };

// the approvals window: everyone's items, kept up to date by the tray
export const approvalsProtocol = defineProtocol(({ state }) => ({
  name: 'gh-approvals/approvals',
  state: {
    devices: state<Devices>('devices'),
    status: state<ApprovalsStatus>('status'),
  },
}));
