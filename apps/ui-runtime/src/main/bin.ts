#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureElectron } from '@cmdless/ensure-electron';
import { runAsBin } from '@cmdless/ui-sdk/node';
import pkg from "../../package.json" with { type: "json" };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.join(__dirname, 'index.js');
const electronVersion = pkg.devDependencies.electron;
const execPath = await ensureElectron({ meta: import.meta, electronVersion, rebuild: true });

const output = await runAsBin(execPath, [mainEntry, ...process.argv.slice(2)]);
process.stdout.write(output);
