// What a named app is to its OS: the name and id it goes by in the Dock or
// taskbar, and in the process list. Electron run as is is "Electron" to all
// of them, so a named app runs from its own copy of Electron, named for it -
// one that costs next to nothing, since it shares the stock copy's files -
// and gets the rest each OS reads its name from. (A throwaway app stays
// Electron.)
//
//   macOS    an APFS clone of the bundle, renamed and re-signed
//   Windows  hard links to Electron's files, as <name>.exe; a Start Menu
//            shortcut carrying the app's id, which names its notifications
//   Linux    hard links to Electron's files, as <name>; a hidden .desktop
//            file its windows are matched to
//
// Windows and Linux are untested.
//
// Plain Node: bin.ts uses it before Electron starts, so nothing here may
// touch electron.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// what a named app is called where people see it - the Dock, the app menu,
// its process - which is its name without an npm scope: @cmdless/gh-approvals
// is gh-approvals
export const displayName = (appName: string) => appName.replace(/^@[^/]+\//, '');

// the display name as a file name and an id can both hold it: the app's
// executable and bundle are named this, and its id is dev.cmdless.<this>
export const exeName = (appName: string) => displayName(appName).replace(/[^A-Za-z0-9.-]+/g, '-');

// the id a named app goes by everywhere: its bundle id on macOS, its
// AppUserModelID on Windows, its .desktop file's name on Linux (so two apps
// differing only by scope share one)
export const appId = (appName: string) => `dev.cmdless.${exeName(appName)}`;

// the app's own copy of Electron, under <root>/apps/<app>/bundles/<electron
// version> - made once per Electron version, and kept - and its executable,
// named for the app. Electron finds its helpers and resources by their own
// names, so only the executable is renamed. The stock executable, if a copy
// can't be made.
export function appExecutable(stockExecPath: string, appName: string, electronVersion: string, root: string) {
  const name = exeName(appName);
  const folder = path.join(root, 'apps', appName, 'bundles', electronVersion);
  const copier = process.platform === 'darwin' ? macBundle : linkedFolder;
  const { target, execPath, make } = copier(stockExecPath, name, folder, appName);
  if (fs.existsSync(execPath)) return execPath;

  // made under a name of its own, then moved into place - two hosts starting
  // at once each make one, and the second finds the first's there
  fs.mkdirSync(folder, { recursive: true });
  const making = fs.mkdtempSync(path.join(folder, '.making-'));
  try {
    const copy = path.join(making, path.basename(target));
    make(copy);
    try {
      fs.renameSync(copy, target);
    } catch (error) {
      if (fs.existsSync(execPath)) return execPath;
      // one made before its executable was renamed: replaced
      if (!fs.existsSync(target)) throw error;
      fs.rmSync(target, { recursive: true, force: true });
      fs.renameSync(copy, target);
    }
    return execPath;
  } catch (error) {
    console.error(`ui-runtime: couldn't make ${appName}'s own copy of Electron, running as Electron:`, (error as Error).message);
    return stockExecPath;
  } finally {
    fs.rmSync(making, { recursive: true, force: true });
  }
}

type Copier = (stockExecPath: string, name: string, folder: string, appName: string) => {
  target: string;
  execPath: string;
  make(copy: string): void;
};

// macOS reads an app's name from its bundle: an APFS clone of Electron's,
// which shares its blocks - only what's changed (Info.plist, the signature)
// takes space
const macBundle: Copier = (stockExecPath, name, folder, appName) => {
  const stock = path.resolve(stockExecPath, '../../..');
  const target = path.join(folder, `${name}.app`);
  return {
    target,
    execPath: path.join(target, 'Contents', 'MacOS', name),
    make(copy) {
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
    },
  };
};

// Windows and Linux name a process by its executable: Electron's folder as
// hard links - the same files, so no space - with the executable's named for
// the app (<name>.exe, <name>)
const linkedFolder: Copier = (stockExecPath, name, folder) => {
  const stock = path.dirname(stockExecPath);
  const target = path.join(folder, name);
  const exe = `${name}${path.extname(stockExecPath)}`;
  return {
    target,
    execPath: path.join(target, exe),
    make(copy) {
      linkTree(stock, copy);
      fs.renameSync(path.join(copy, path.basename(stockExecPath)), path.join(copy, exe));
    },
  };
};

// a folder's files hard-linked into another - fails, rather than copying, if
// they're on different volumes
function linkTree(from: string, to: string) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const destination = path.join(to, entry.name);
    if (entry.isDirectory()) linkTree(source, destination);
    else if (entry.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(source), destination);
    else fs.linkSync(source, destination);
  }
}

// Windows: where a named app's Start Menu shortcut goes. Windows names an
// app's notifications from the shortcut carrying its id - without one, it
// shows the id itself.
export function startMenuShortcut(appName: string) {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'cmdless', `${displayName(appName)}.lnk`);
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
