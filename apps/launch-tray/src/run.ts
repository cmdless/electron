// Running a launch: its commands one after another, each waited on, the
// first that fails ending it. Each runs detached in the home folder, so
// whatever it starts outlives the tray, with its output appended to the
// launch's own log.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { Launch } from '@cmdless/ui-sdk';

export const logsFolder = (userData: string) => path.join(userData, 'logs');
export const logFileFor = (userData: string, launchFile: string) =>
  path.join(logsFolder(userData), `${path.basename(launchFile, path.extname(launchFile))}.log`);

function runCommand(command: string, args: string[], log: number) {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: os.homedir(), detached: true, stdio: ['ignore', log, log], windowsHide: true,
      // npx and the like are .cmd files there, which only a shell runs
      shell: process.platform === 'win32',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    child.unref();
  });
}

// runs it, and says how it ended: undefined if every command succeeded, or
// what failed
export async function runLaunch(launch: Launch, logFile: string) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const log = fs.openSync(logFile, 'a');
  const note = (line: string) => fs.writeSync(log, `${new Date().toISOString()} ${line}\n`);
  try {
    note(`launching ${launch.name}`);
    for (const { command, args } of launch.commands) {
      note(`$ ${[command, ...args].join(' ')}`);
      let code: number;
      try {
        code = await runCommand(command, args, log);
      } catch (error) {
        note(`couldn't run ${command}: ${(error as Error).message}`);
        return `couldn't run ${command}: ${(error as Error).message}`;
      }
      if (code !== 0) {
        note(`${command} exited ${code}`);
        return `${command} exited ${code}`;
      }
    }
    note(`${launch.name} done`);
    return undefined;
  } finally {
    fs.closeSync(log);
  }
}
