// The launcher on macOS: an AppleScript droplet that claims .cmdless files,
// and a shell script it hands each opened file to. Finder delivers an
// opened file to an app as an Apple Event, which a droplet's `on open` gets
// for free; the droplet starts the script in the background and quits, and
// the script runs `launch open` with this node and this bin.
//
//   <launch root>/
//     launcher            the script - rewritten whenever node or the bin move
//     cmdless launch.app  the droplet - LSUIElement, so no Dock icon

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Launcher } from './launch.js';
import { scriptPath, writeScript } from './launch-script.js';

export const BUNDLE_ID = 'dev.cmdless.launch';
export const FILE_TYPE = 'dev.cmdless.launch-file';
const APP_NAME = 'cmdless launch';
const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

const appPath = (root: string) => path.join(root, `${APP_NAME}.app`);

export const macOSInstalled = (root: string) => fs.existsSync(appPath(root)) && fs.existsSync(scriptPath(root));

const appleScriptString = (value: string) => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;

// the droplet: each file it's given goes to the script, in the background,
// so the droplet quits at once
function dropletSource(root: string) {
  return [
    'on open theFiles',
    '\trepeat with theFile in theFiles',
    `\t\tdo shell script quoted form of ${appleScriptString(scriptPath(root))} & " " & quoted form of (POSIX path of theFile) & " > /dev/null 2>&1 &"`,
    '\tend repeat',
    'end open',
    '',
    'on run',
    'end run',
    '',
  ].join('\n');
}

const plist = (app: string, key: string, type: '-json' | '-bool' | '-string', value: string) =>
  execFileSync('plutil', ['-replace', key, type, value, path.join(app, 'Contents', 'Info.plist')]);

// made beside where it goes, then moved into place - what's there is only
// ever whole
function writeDroplet(root: string) {
  const target = appPath(root);
  const making = fs.mkdtempSync(path.join(root, '.making-'));
  try {
    const source = path.join(making, 'droplet.applescript');
    const app = path.join(making, `${APP_NAME}.app`);
    fs.writeFileSync(source, dropletSource(root));
    execFileSync('osacompile', ['-o', app, source]);
    plist(app, 'CFBundleIdentifier', '-string', BUNDLE_ID);
    plist(app, 'CFBundleName', '-string', APP_NAME);
    plist(app, 'LSUIElement', '-bool', 'YES');
    plist(app, 'CFBundleDocumentTypes', '-json', JSON.stringify([{
      CFBundleTypeName: 'cmdless launch',
      CFBundleTypeRole: 'Viewer',
      LSHandlerRank: 'Owner',
      LSItemContentTypes: [FILE_TYPE],
    }]));
    plist(app, 'UTExportedTypeDeclarations', '-json', JSON.stringify([{
      UTTypeIdentifier: FILE_TYPE,
      UTTypeDescription: 'cmdless launch',
      UTTypeConformsTo: ['public.json'],
      UTTypeTagSpecification: { 'public.filename-extension': ['cmdless'] },
    }]));
    // its Info.plist changed under the signature osacompile gave it
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'ignore' });
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(app, target);
  } finally {
    fs.rmSync(making, { recursive: true, force: true });
  }
}

// tells Launch Services about the droplet, and makes it what opens .cmdless
// files - the only app that claims them, but said outright anyway
function register(root: string) {
  execFileSync(LSREGISTER, ['-f', '-R', appPath(root)]);
  execFileSync('osascript', ['-l', 'JavaScript', '-e', [
    "ObjC.import('CoreServices');",
    `$.LSSetDefaultRoleHandlerForContentType(${JSON.stringify(FILE_TYPE)}, 0xFFFFFFFF, ${JSON.stringify(BUNDLE_ID)});`,
  ].join('\n')], { stdio: 'ignore' });
}

export async function installMacOS(root: string, launcher: Launcher) {
  writeScript(root, launcher);
  writeDroplet(root);
  register(root);
}
