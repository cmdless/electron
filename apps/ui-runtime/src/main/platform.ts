// What a named app is to its OS: the name and id its windows go by in the
// Dock or taskbar. Electron run as is is "Electron" to all of them - macOS
// reads the name from the app bundle, Linux from a .desktop file, Windows
// from the id a process sets - so a named app gets its own of each. (A
// throwaway app keeps Electron's.)
//
// Plain Node: bin.ts uses it before Electron starts, so nothing here may
// touch electron.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// an app name as an id can hold it - an npm scope as a part of its own:
// @cmdless/gh-approvals is cmdless.gh-approvals
const idOf = (appName: string) => appName.replace(/^@/, '').replace(/\//g, '.').replace(/[^A-Za-z0-9.-]+/g, '-');

// the id a named app goes by everywhere: its bundle id on macOS, its
// AppUserModelID on Windows, its .desktop file's name on Linux
export const appId = (appName: string) => `dev.cmdless.${idOf(appName)}`;

// what a named app is called where people see it - the Dock, the app menu,
// its process - which is its name without an npm scope: @cmdless/gh-approvals
// is gh-approvals
export const displayName = (appName: string) => appName.replace(/^@[^/]+\//, '');

// a display name as a file name can hold it
const fileNameOf = (appName: string) => displayName(appName).replace(/[/\\:]+/g, '-');

// macOS: the app's own copy of Electron's bundle, named for it, under
// <root>/apps/<app>/bundles/<electron version> - made once per Electron
// version, and kept. Its executable goes by the app's name too, so ps and
// Activity Monitor show it; the helpers stay Electron's, since Electron finds
// them by their own names. It's an APFS clone, so it shares the stock
// bundle's blocks and only what's changed (Info.plist, the signature) takes
// space. The stock executable, if a copy can't be made.
export function appBundle(stockExecPath: string, appName: string, electronVersion: string, root: string) {
  const stock = path.resolve(stockExecPath, '../../..');
  const name = fileNameOf(appName);
  const folder = path.join(root, 'apps', appName, 'bundles', electronVersion);
  const bundle = path.join(folder, `${name}.app`);
  const execPath = path.join(bundle, 'Contents', 'MacOS', name);
  if (fs.existsSync(execPath)) return execPath;

  // made under a name of its own, then moved into place - two hosts starting
  // at once each make one, and the second finds the first's there
  fs.mkdirSync(folder, { recursive: true });
  const making = fs.mkdtempSync(path.join(folder, '.making-'));
  try {
    const copy = path.join(making, path.basename(bundle));
    // -c clones, or fails: never a full copy
    execFileSync('cp', ['-cR', stock, copy], { stdio: 'ignore' });
    fs.renameSync(path.join(copy, path.relative(stock, stockExecPath)), path.join(copy, 'Contents', 'MacOS', name));
    const plist = path.join(copy, 'Contents', 'Info.plist');
    const keys = {
      CFBundleName: displayName(appName),
      CFBundleDisplayName: displayName(appName),
      CFBundleExecutable: name,
      CFBundleIdentifier: appId(appName),
    };
    for (const [key, value] of Object.entries(keys))
      execFileSync('plutil', ['-replace', key, '-string', value, plist], { stdio: 'ignore' });
    // only the outer bundle: what's inside keeps the stock bundle's
    // signatures, and its blocks
    execFileSync('codesign', ['--force', '--sign', '-', copy], { stdio: 'ignore' });
    try {
      fs.renameSync(copy, bundle);
    } catch (error) {
      if (fs.existsSync(execPath)) return execPath;
      // one made before its executable was renamed: replaced
      if (!fs.existsSync(bundle)) throw error;
      fs.rmSync(bundle, { recursive: true, force: true });
      fs.renameSync(copy, bundle);
    }
    return execPath;
  } catch (error) {
    console.error(`ui-runtime: couldn't make ${appName}'s own app bundle, running as Electron:`, (error as Error).message);
    return stockExecPath;
  } finally {
    fs.rmSync(making, { recursive: true, force: true });
  }
}

// Linux: the .desktop file a named app's windows are matched to, by the
// window class Electron gives them (the app name) - hidden from launchers,
// since it's only there to name the app. Its file name, for
// app.setDesktopName.
export function writeDesktopFile(appName: string, execPath: string) {
  const name = `${appId(appName)}.desktop`;
  const file = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'applications', name);
  const text = [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${displayName(appName)}`,
    `Exec="${execPath}"`,
    `StartupWMClass=${appName}`,
    'NoDisplay=true',
    '',
  ].join('\n');
  try {
    if (fs.readFileSync(file, 'utf8') === text) return name;
  } catch { /* not there yet */ }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  } catch (error) {
    console.error(`ui-runtime: couldn't write ${file}:`, (error as Error).message);
  }
  return name;
}
