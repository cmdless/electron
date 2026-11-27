#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { ensureElectron, getDefaultCmdlessRoot } from '@cmdless/ensure-electron';
import { getCmdlessApp, isEphemeralCmdlessApp } from '@cmdless/ui-sdk/node';
import { appExecutable } from './platform.js';
import { LaunchHost } from '@cmdless/ui-sdk/node';
import { ensureLauncher, launchRoot, logLaunch, readLaunch } from './launch.js';
import pkg from "../../package.json" with { type: "json" };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const hostEntry = path.join(__dirname, 'host.js');
const electronVersion = pkg.devDependencies.electron;

// Electron ships for macOS only linker-signed - an ad hoc signature that
// doesn't cover the bundle - and macOS won't let such an app post
// notifications at all. Giving the downloaded copy a complete ad hoc
// signature, made here on this machine, makes it a normal app to macOS: it
// asks for notification permission once, then delivers them. Checked once per
// download; the marker sits beside the bundle, since anything inside would
// break the signature again. (This belongs in ensure-electron, which does the
// downloading - it lives here until then.)
function signForMacOS(execPath: string) {
  if (process.platform !== 'darwin') return;
  const bundle = path.resolve(execPath, '../../..');
  const marker = path.join(path.dirname(bundle), '.cmdless-signed');
  if (fs.existsSync(marker)) return;
  try {
    execFileSync('codesign', ['--verify', '--deep', '--strict', bundle], { stdio: 'ignore' });
  } catch {
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', bundle], { stdio: 'ignore' });
  }
  fs.writeFileSync(marker, '');
}

const program = new Command().name('ui-runtime');

// the one host process for an app: everything it needs comes through its
// env, so it takes no arguments
program
  .command('host').description('Run the host for the app named in CMDLESS_APP (or a throwaway one)')
  .action(async () => {
    const stockExecPath = await ensureElectron({ meta: import.meta, electronVersion, rebuild: true });
    signForMacOS(stockExecPath);
    // a named app runs as itself; a throwaway one (named only once it's
    // running) as Electron
    const app = getCmdlessApp();
    const execPath = app && !isEphemeralCmdlessApp(app)
      ? appExecutable(stockExecPath, app, electronVersion, getDefaultCmdlessRoot())
      : stockExecPath;
    const child = spawn(execPath, [hostEntry], { stdio: 'inherit' });
    child.once('exit', code => { process.exitCode = code ?? 1; });
  });

// .cmdless files: install sets up the shim that opens them through this
// bin; add and open make sure it's there, then hand a file's launch to
// @cmdless/launch-tray
const launch = program.command('launch').description('Open .cmdless files through @cmdless/launch-tray');

launch
  .command('install').description('Set up opening .cmdless files on this machine, through this runtime')
  .action(async () => {
    const changed = await ensureLauncher(pkg.version);
    console.log(changed ? `set up in ${launchRoot()}` : `already set up in ${launchRoot()}`);
  });

launch
  .command('add').description('Add a .cmdless file to @cmdless/launch-tray')
  .argument('<file>', 'The .cmdless file')
  .action(async (file: string) => {
    await ensureLauncher(pkg.version);
    const launch = readLaunch(file);
    console.log(`${launch.name}: ${await LaunchHost.add(launch)}`);
  });

// run by the shim, with nowhere to show output - what happens goes to the
// launcher's log
launch
  .command('open').description('Open a .cmdless file through @cmdless/launch-tray - what the shim runs')
  .argument('<file>', 'The .cmdless file')
  .option('--command <name>', 'Which of its named commands to run - asked, if it has several and this is left out')
  .option('--keep', 'Keep it under Launch in the tray as well')
  .action(async (file: string, { command, keep }: { command?: string; keep?: boolean }) => {
    try {
      await ensureLauncher(pkg.version);
      const launch = readLaunch(file);
      logLaunch(`open ${file}: ${await LaunchHost.open(launch, { command, keep })}`);
    } catch (error) {
      logLaunch(`open ${file} failed: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  });

await program.parseAsync();
