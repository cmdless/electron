// The launcher script macOS and Linux share: what the platform's shim hands
// an opened file to. Node's own folder goes first on PATH, since whatever
// opens a file from the desktop runs with the system's PATH, where npm isn't
// - and the root it was set up with, if that was moved.

import fs from 'node:fs';
import path from 'node:path';
import type { Launcher } from './launch.js';

export const scriptPath = (root: string) => path.join(root, 'launcher');

export const shQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

export function writeScript(root: string, { node, bin, root: cmdlessRoot }: Launcher) {
  const script = scriptPath(root);
  fs.writeFileSync(script, [
    '#!/bin/sh',
    `PATH=${shQuote(path.dirname(node))}:"$PATH"`,
    'export PATH',
    ...cmdlessRoot ? [`CMDLESS_ROOT=${shQuote(cmdlessRoot)}`, 'export CMDLESS_ROOT'] : [],
    `exec ${shQuote(node)} ${shQuote(bin)} launch open "$@"`,
    '',
  ].join('\n'));
  fs.chmodSync(script, 0o755);
}
