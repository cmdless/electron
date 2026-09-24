#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { ensureElectron } from '@cmdless/ensure-electron';
import type { BinMessage, BinCleanup } from '@cmdless/ui-sdk/node';
import { binOutput } from '@cmdless/ui-sdk/node';
import pkg from "../../package.json" with { type: "json" };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.join(__dirname, '../out/main/index.js');
const electronVersion = pkg.devDependencies.electron;
const execPath = await ensureElectron({ meta: import.meta, electronVersion, rebuild: true });
const child = spawn(execPath, [mainEntry, ...process.argv.slice(2)], { stdio: ['inherit', 'pipe', 'inherit', 'ipc'] });
child.stdout?.pipe(process.stderr);

let cleanup: BinCleanup | undefined;
child.on('message', (message: BinMessage) => {
  if (message.type === 'cleanup') {
    cleanup = message;
    return;
  }
  if (message.value !== null)
    process.stdout.write(binOutput(message.value));
});
child.on('exit', code => {
  if (cleanup)
    fs.rmSync(cleanup.userData, { recursive: true, force: true });
  process.exitCode = code ?? 1;
});