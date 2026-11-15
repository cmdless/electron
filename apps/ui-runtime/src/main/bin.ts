#!/usr/bin/env node

import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { ensureElectron } from '@cmdless/ensure-electron';
import { runAsBin } from '@cmdless/ui-sdk/node';
import pkg from "../../package.json" with { type: "json" };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainEntry = path.join(__dirname, 'index.js');
const hostedEntry = path.join(__dirname, 'hosted.js');
const electronVersion = pkg.devDependencies.electron;
const execPath = await ensureElectron({ meta: import.meta, electronVersion, rebuild: true });

const program = new Command()
  .name('ui-runtime')
  // anything but `host` is the current main's to parse, help included
  .helpOption(false)
  .allowUnknownOption()
  .allowExcessArguments()
  .action(async () => {
    const output = await runAsBin(execPath, [mainEntry, ...process.argv.slice(2)]);
    process.stdout.write(output);
  });

// the one host process: everything it needs comes through its env
program
  .command('host')
  .action(() => {
    const child = spawn(execPath, [hostedEntry], { stdio: 'inherit' });
    child.once('exit', code => { process.exitCode = code ?? 1; });
  });

await program.parseAsync();
