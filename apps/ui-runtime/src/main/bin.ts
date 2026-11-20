#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { ensureElectron, getDefaultCmdlessRoot } from '@cmdless/ensure-electron';
import { getCmdlessApp, isEphemeralCmdlessApp } from '@cmdless/ui-sdk/node';
import { appExecutable } from './platform.js';
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

await program.parseAsync();
