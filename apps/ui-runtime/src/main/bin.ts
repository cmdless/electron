#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { ensureElectron } from '@cmdless/ensure-electron';
import { BinChannel } from '@cmdless/ui-sdk/node';
import { wireChild } from './lib/wireChild.js';
import pkg from "../../package.json" with { type: "json" };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.join(__dirname, 'index.js');
const electronVersion = pkg.devDependencies.electron;
const execPath = await ensureElectron({ meta: import.meta, electronVersion, rebuild: true });

const { onMessage, onExit } = wireChild(
  text => process.stdout.write(text),
  userData => fs.rmSync(userData, { recursive: true, force: true }),
);
const channel = await BinChannel.start(onMessage);

// no 'ipc' stdio slot - that combination is a documented source of Electron
// init hangs (electron/electron#17044); BinChannel replaces it with a plain
// local socket instead.
const child = spawn(execPath, [mainEntry, ...process.argv.slice(2)], {
  stdio: ['inherit', 'pipe', 'inherit'],
  env: channel.env,
});
child.stdout?.pipe(process.stderr);
child.once('exit', onExit);

// without this, killing this process (rather than the electron child itself)
// leaves the child running and orphaned - wireChild's cleanup only runs once
// the child actually exits, so it'd never fire either. `.on`, not `.once`:
// see the comment on forwardSignals in ui-sdk/node/utils.ts.
const forwardSignal = (signal: NodeJS.Signals) => child.kill(signal);
process.on('SIGINT', forwardSignal);
process.on('SIGTERM', forwardSignal);
child.once('exit', () => {
  process.off('SIGINT', forwardSignal);
  process.off('SIGTERM', forwardSignal);
  channel.close().catch(() => { });
});
