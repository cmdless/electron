#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensurePeerlink } from '@cmdless/peerlink-sdk/node';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const daemonPath = path.join(__dirname, 'daemon.js');

// prints this device's peerlink state, starting the daemon if needed
const peerlink = await ensurePeerlink(daemonPath);
try {
  const read = async <T>(channel: { subscribe: (listener: (state: T) => void) => Promise<() => void> }) => {
    let value: T | undefined;
    (await channel.subscribe(state => value = state))();
    return value;
  };
  const [host, settings, offers] = await Promise.all([
    read(peerlink.state.host), read(peerlink.state.settings), read(peerlink.state.offers),
  ]);
  // addresses carry tokens, so they aren't printed
  const listed = Object.values(offers ?? {}).map(({ id, kind, name }) => ({ id, kind, name }));
  process.stdout.write(JSON.stringify({ host, settings, offers: listed }, null, 2) + '\n');
} finally {
  peerlink.dispose();
}
