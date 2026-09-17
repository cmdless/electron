#!/usr/bin/env node

import { Command } from 'commander';
import { runAsRuntime } from '@cmdless/ui-sdk/main';

const program = new Command();

program
  .option('--install-path <path>')
  .argument('[args...]')
  .action(async (args: string[], options: { installPath?: string }) => {
    const buffer = await runAsRuntime(import.meta, args, options.installPath);
    process.stdout.write(buffer);
  });

await program.parseAsync();