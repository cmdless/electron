// The launcher on Linux - a draft, not yet tested on Linux.
//
// The freedesktop way, per user: a MIME type for *.cmdless files, a desktop
// entry that opens that type with the launcher script (the one macOS uses
// too), and that entry made the type's default.
//
//   <launch root>/launcher                                    the script
//   $XDG_DATA_HOME/mime/packages/cmdless-launch.xml           the type
//   $XDG_DATA_HOME/applications/dev.cmdless.launch.desktop    the entry - NoDisplay, so it's not in menus
//
// ($XDG_DATA_HOME being ~/.local/share unless it's set.) Untested caveats:
// update-mime-database and xdg-mime come with most desktops but not every
// minimal install, and a file manager may need restarting to see the type.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Launcher } from './launch.js';
import { scriptPath, writeScript } from './launch-script.js';

const MIME_TYPE = 'application/x-cmdless-launch';
const DESKTOP_FILE = 'dev.cmdless.launch.desktop';

const dataHome = () => process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
const mimeFile = () => path.join(dataHome(), 'mime', 'packages', 'cmdless-launch.xml');
const desktopFile = () => path.join(dataHome(), 'applications', DESKTOP_FILE);

export const MIME_XML = `<?xml version="1.0" encoding="UTF-8"?>
<mime-info xmlns="http://www.freedesktop.org/standards/shared-mime-info">
  <mime-type type="${MIME_TYPE}">
    <comment>cmdless launch</comment>
    <sub-class-of type="application/json"/>
    <glob pattern="*.cmdless"/>
  </mime-type>
</mime-info>
`;

// an Exec argument: quoted, with what the desktop entry spec reserves inside
// quotes escaped, and % doubled
const execArg = (value: string) => `"${value.replace(/(["`$\\])/g, '\\$1').replaceAll('%', '%%')}"`;

export function desktopEntry(root: string) {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=cmdless launch',
    `Exec=${execArg(scriptPath(root))} %f`,
    `MimeType=${MIME_TYPE};`,
    'NoDisplay=true',
    'Terminal=false',
    '',
  ].join('\n');
}

export const linuxInstalled = (root: string) =>
  fs.existsSync(scriptPath(root)) && fs.existsSync(mimeFile()) && fs.existsSync(desktopFile());

export async function installLinux(root: string, launcher: Launcher) {
  writeScript(root, launcher);
  fs.mkdirSync(path.dirname(mimeFile()), { recursive: true });
  fs.writeFileSync(mimeFile(), MIME_XML);
  fs.mkdirSync(path.dirname(desktopFile()), { recursive: true });
  fs.writeFileSync(desktopFile(), desktopEntry(root));
  execFileSync('update-mime-database', [path.join(dataHome(), 'mime')], { stdio: 'ignore' });
  // only refreshes a cache some desktops keep - fine if it isn't there
  try {
    execFileSync('update-desktop-database', [path.dirname(desktopFile())], { stdio: 'ignore' });
  } catch { }
  execFileSync('xdg-mime', ['default', DESKTOP_FILE, MIME_TYPE], { stdio: 'ignore' });
}
