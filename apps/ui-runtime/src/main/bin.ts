#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { ensureElectron } from '@cmdless/ensure-electron';
import { wireChild } from './lib/wireChild.js';
import pkg from "../../package.json" with { type: "json" };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.join(__dirname, '../out/main/index.js');
const electronVersion = pkg.devDependencies.electron;
const execPath = await ensureElectron({ meta: import.meta, electronVersion, rebuild: true });
const child = spawn(execPath, [mainEntry, ...process.argv.slice(2)], { stdio: ['inherit', 'pipe', 'inherit', 'ipc'] });
child.stdout?.pipe(process.stderr);

wireChild(
  child,
  text => process.stdout.write(text),
  userData => fs.rmSync(userData, { recursive: true, force: true }),
);