#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensurePeerlink } from '@cmdless/peerlink-sdk/node';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const daemonPath = path.join(__dirname, 'daemon.js');

// prints this device's peerlink state, starting the daemon if needed;
// `peerlink sign-in` / `peerlink sign-out` first sign in to or out of Dropbox
const [command] = process.argv.slice(2);
const peerlink = await ensurePeerlink(daemonPath);
try {
  if (command === 'sign-in') await peerlink.request.signIn();
  else if (command === 'sign-out') await peerlink.request.signOut();

  const read = async <T>(channel: { subscribe: (listener: (state: T) => void) => Promise<() => void> }) => {
    let value: T | undefined;
    (await channel.subscribe(state => value = state))();
    return value;
  };
  const [host, settings, offers, account, devices] = await Promise.all([
    read(peerlink.state.host), read(peerlink.state.settings), read(peerlink.state.offers),
    read(peerlink.state.account), read(peerlink.state.devices),
  ]);
  // addresses carry tokens, so they aren't printed
  const listed = Object.values(offers ?? {}).map(({ id, kind, name }) => ({ id, kind, name }));
  process.stdout.write(JSON.stringify({ host, settings, account, offers: listed, devices }, null, 2) + '\n');
} finally {
  peerlink.dispose();
}
