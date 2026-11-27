// The kept launches: a .cmdless file each in the tray's userData, in
// launches/, named after the launch.

import fs from 'node:fs';
import path from 'node:path';
import { parseLaunch } from '@cmdless/ui-sdk';
import type { Launch } from '@cmdless/ui-sdk';

// one that's kept: what it says, and where
export type KeptLaunch = Launch & { file: string };

export const EXTENSION = '.cmdless';

export const launchesFolder = (userData: string) => path.join(userData, 'launches');

// where a launch is kept: its name, made safe to be a file's
export const keptFile = (userData: string, name: string) => path.join(launchesFolder(userData),
  `${name.replace(/[\\/:*?"<>|\x00-\x1f]+/g, '-').replace(/^[.\s]+|[.\s]+$/g, '') || 'launch'}${EXTENSION}`);

export function keep(userData: string, launch: Launch) {
  const file = keptFile(userData, launch.name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ name: launch.name, commands: launch.commands }, null, 2)}\n`);
  return { ...launch, file };
}

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
      kept.push({ ...parseLaunch(fs.readFileSync(file, 'utf8')), file });
    } catch (error) {
      onBad(file, error as Error);
    }
  }
  return kept.sort((a, b) => a.name.localeCompare(b.name));
}
