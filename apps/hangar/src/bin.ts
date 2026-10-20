#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureHangar } from '@cmdless/hangar-sdk/node';
import type { HostState } from '@cmdless/hangar-sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const daemonPath = path.join(__dirname, 'daemon.js');

const [command, ...args] = process.argv.slice(2);
const hangar = await ensureHangar(daemonPath);
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
