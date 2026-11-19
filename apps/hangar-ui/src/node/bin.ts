#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireCmdlessUrl, UIHost } from '@cmdless/ui-sdk/node';
import { ensureHangar } from '@cmdless/hangar-sdk/node';
import { windowProtocol } from '../shared/protocols.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distIndex = path.join(__dirname, '../../dist/index.html');
const daemonPath = fileURLToPath(import.meta.resolve('@cmdless/hangar/daemon'));

// starts the daemon if it isn't running, and asks it where its WebSocket is
const hangar = await ensureHangar(daemonPath);
let url = '';
const stop = await hangar.state.host.subscribe(host => url = host.webSocketAddress);
stop();
hangar.dispose();

// a dev server (the vite plugin) publishes its own URL, shown instead of the
// built renderer. hangar's WebSocket address carries its token, so the
// window asks this process for it over its backend rather than its URL.
const dev = acquireCmdlessUrl();
await UIHost.showWindow({ app: 'hangar' }, {
  type: dev ? 'url' : 'file',
  source: `${dev || distIndex}#/agents`,
  window: { width: 1000, height: 720 },
}, windowProtocol.accept(page => page.onRequest.hangar(() => ({ url }))));
