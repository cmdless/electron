// Running a launch: its command lines one after another, each waited on, the
// first that fails ending it. Each runs detached in the home folder, so
// whatever it starts outlives the tray, with its output appended to the
// launch's own log.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { CommandLine } from './sources.js';

export const logsFolder = (userData: string) => path.join(userData, 'logs');
export const logFileFor = (userData: string, launchFile: string) =>
  path.join(logsFolder(userData), `${path.basename(launchFile, path.extname(launchFile))}.log`);

function runCommand({ command, args }: CommandLine, log: number) {
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

// runs them, and says how it ended: undefined if every one succeeded, or
// what failed
export async function runLaunch(name: string, lines: CommandLine[], logFile: string) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const log = fs.openSync(logFile, 'a');
  const note = (line: string) => fs.writeSync(log, `${new Date().toISOString()} ${line}\n`);
  try {
    note(`launching ${name}`);
    for (const line of lines) {
      note(`$ ${[line.command, ...line.args].join(' ')}`);
      let code: number;
      try {
        code = await runCommand(line, log);
      } catch (error) {
        note(`couldn't run ${line.command}: ${(error as Error).message}`);
        return `couldn't run ${line.command}: ${(error as Error).message}`;
      }
      if (code !== 0) {
        note(`${line.command} exited ${code}`);
        return `${line.command} exited ${code}`;
      }
    }
    note(`${name} done`);
    return undefined;
  } finally {
    fs.closeSync(log);
  }
}
