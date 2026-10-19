#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitForService } from '@cmdless/core/node';
import { connectHangar } from '@cmdless/hangar-sdk/node';
import type { HangarService, HostState } from '@cmdless/hangar-sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const daemonPath = path.join(__dirname, 'daemon.js');

// connects to the running daemon, starting it first if nothing answers
async function ensureHangar() {
  try {
    return await connectHangar();
  } catch {
    const { value } = await waitForService<HangarService>(process.execPath, [daemonPath]);
    return connectHangar(value.address);
  }
}

const [command, ...args] = process.argv.slice(2);
const hangar = await ensureHangar();
try {
  if (command === 'restart')
    await hangar.request.restart({ force: args.includes('--force') });

  let host: HostState | undefined;
  const stop = await hangar.state.host.subscribe(state => host = state);
  stop();
  process.stdout.write(JSON.stringify(host) + '\n');
} finally {
  hangar.dispose();
}
