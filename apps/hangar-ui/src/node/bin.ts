#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createShowCommand } from '@cmdless/ui-sdk/node';
import { ensureHangar } from '@cmdless/hangar-sdk/node';
import { windowProtocol } from '../shared/protocols.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distIndex = path.join(__dirname, '../../dist/index.html');
const daemonPath = fileURLToPath(import.meta.resolve('@cmdless/hangar/daemon'));

// hangar's WebSocket address carries its token, so it's handed to the window
// over the window's own (token-guarded) connection rather than put in its URL
const showHangar = createShowCommand<{ url: string }, void>({
  params: () => ({ type: 'file', source: `${distIndex}#/agents`, app: 'hangar', width: 1000, height: 720 }),
  transport: async ({ url }) => {
    const { accept } = await windowProtocol.defineHost({
      configure: server => server.onRequest.hangar(() => ({ url })),
    })();
    return { accept, options: { port: 0, host: '127.0.0.1' } };
  },
  result: () => undefined,
});

// starts the daemon if it isn't running, and asks it where its WebSocket is
const hangar = await ensureHangar(daemonPath);
let url = '';
const stop = await hangar.state.host.subscribe(host => url = host.webSocketAddress);
stop();
hangar.dispose();

await showHangar({ url });
