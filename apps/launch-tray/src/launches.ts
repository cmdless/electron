// .cmdless files: JSON naming something to launch, and the commands that
// launch it, run in order. The ones added are kept in the tray's userData,
// in launches/ - only those run without asking.

import fs from 'node:fs';
import path from 'node:path';

export type LaunchCommand = { command: string; args: string[] };
export type Launch = { name: string; commands: LaunchCommand[] };

// one that's kept: what it says, and where
export type KeptLaunch = Launch & { file: string };

export const EXTENSION = '.cmdless';

const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every(each => typeof each === 'string');

// a .cmdless file's contents, checked - throws saying what's wrong
export function parseLaunch(text: string): Launch {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`it isn't JSON: ${(error as Error).message}`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('it isn\'t a JSON object');
  const { name, commands } = data as Record<string, unknown>;
  if (typeof name !== 'string' || !name.trim()) throw new Error('it has no name');
  if (!Array.isArray(commands) || commands.length === 0) throw new Error('it has no commands');
  return {
    name: name.trim(),
    commands: commands.map((each, i) => {
      const { command, args = [] } = (each ?? {}) as Record<string, unknown>;
      if (typeof command !== 'string' || !command.trim()) throw new Error(`command ${i + 1} has no command`);
      if (!isStrings(args)) throw new Error(`command ${i + 1}'s args aren't all strings`);
      return { command, args };
    }),
  };
}

export const readLaunch = (file: string) => parseLaunch(fs.readFileSync(file, 'utf8'));

// how a launch reads, a command to a line - what someone's asked to trust
export const describeLaunch = ({ commands }: Launch) =>
  commands.map(({ command, args }) => [command, ...args].map(arg => /^[\w@%+=:,./-]+$/.test(arg) ? arg : JSON.stringify(arg)).join(' ')).join('\n');

// where kept launches live
export const launchesFolder = (userData: string) => path.join(userData, 'launches');

// whether a file is one of the kept ones - in the folder itself, not below
export function isKept(userData: string, file: string) {
  return path.dirname(path.resolve(file)) === path.resolve(launchesFolder(userData));
}

// a launch's file name in the folder: its name, made safe to be one
export const keptFileName = (name: string) =>
  `${name.replace(/[\\/:*?"<>|\x00-\x1f]+/g, '-').replace(/^[.\s]+|[.\s]+$/g, '') || 'launch'}${EXTENSION}`;

// every kept launch that reads, by name - one that doesn't is left out, and
// said so to onBad
export function keptLaunches(userData: string, onBad: (file: string, error: Error) => void = () => { }): KeptLaunch[] {
  const folder = launchesFolder(userData);
  if (!fs.existsSync(folder)) return [];
  const kept: KeptLaunch[] = [];
  for (const entry of fs.readdirSync(folder)) {
    if (!entry.endsWith(EXTENSION)) continue;
    const file = path.join(folder, entry);
    try {
      kept.push({ ...readLaunch(file), file });
    } catch (error) {
      onBad(file, error as Error);
    }
  }
  return kept.sort((a, b) => a.name.localeCompare(b.name));
}
