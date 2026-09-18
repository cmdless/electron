#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { ensureElectron } from '@cmdless/ensure-electron';
import pkg from "../../package.json" with { type: "json" };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.join(__dirname, '../out/main/index.js');
const electronVersion = pkg.devDependencies.electron;
const execPath = await ensureElectron({ meta: import.meta, electronVersion, rebuild: true });
const child = spawn(execPath, [mainEntry, ...process.argv.slice(2)], { stdio: 'inherit' });
child.on('exit', code => process.exitCode = code ?? 1);