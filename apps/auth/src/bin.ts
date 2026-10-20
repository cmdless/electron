#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureAuth } from '@cmdless/auth-sdk/node';
import type { ProviderStatus } from '@cmdless/auth-sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const daemonPath = path.join(__dirname, 'daemon.js');

// prints which providers are signed in, starting the broker if needed -
// tokens themselves only ever go to a client that asks for one
const auth = await ensureAuth(daemonPath);
try {
  let providers: Record<string, ProviderStatus> | undefined;
  (await auth.state.providers.subscribe(state => providers = state))();
  process.stdout.write(JSON.stringify(providers, null, 2) + '\n');
} finally {
  auth.dispose();
}
