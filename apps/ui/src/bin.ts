#!/usr/bin/env node

import { Command } from 'commander';
import { runAsPackage, runAsRuntime } from '@cmdless/ui-sdk/main';

const program = new Command();

program
  .option('-p, --package <specifier>')
  .argument('[args...]')
  .action(async (args: string[], options: { package?: string }) => {
    const buffer = options.package
      ? await runAsPackage({ specifier: options.package }, args)
      : await runAsRuntime(import.meta, args);
    process.stdout.write(buffer);
  });

await program.parseAsync();