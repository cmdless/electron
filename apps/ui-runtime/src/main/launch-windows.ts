// The launcher on Windows - a draft, not yet tested on Windows.
//
// node.exe and npx.cmd are console programs, so anything a .cmdless file
// opens through them directly would flash a console. Instead .cmdless files
// open with wscript.exe, which has no console, running hidden.js: it reads
// launcher.json beside it (what to run - written by launch.ts) and starts
// `launch open` with that node and bin, hidden, without waiting. The
// registry entry only ever names hidden.js, so it never changes when node or
// the bin moves.
//
//   <launch root>/
//     hidden.js       the shim wscript runs
//     launcher.json   what it runs
//
//   HKCU\Software\Classes\.cmdless                          (default) cmdless.launch
//   HKCU\Software\Classes\cmdless.launch                    (default) cmdless launch
//   HKCU\Software\Classes\cmdless.launch\shell\open\command (default) wscript.exe //B "<root>\hidden.js" "%1"
//
// Per user, so no admin. Untested caveats: a choice of another app for
// .cmdless made earlier in Explorer's "Open with" (UserChoice) wins over this,
// and can't be undone from here; and Explorer may not show the new
// association until it notices the change (SHChangeNotify, or a sign-out).

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Launcher } from './launch.js';

const PROG_ID = 'cmdless.launch';
const CLASSES = 'HKCU\\Software\\Classes';

const shimPath = (root: string) => path.join(root, 'hidden.js');

// JScript, as wscript runs it: launcher.json read as UTF-8 (paths needn't be
// ASCII), node's folder first on PATH, CMDLESS_ROOT if one was set, and the
// command run hidden (0) without waiting (false)
export const SHIM = `// run by wscript.exe for each .cmdless file opened - see ui-runtime's launch-windows.ts
var fso = new ActiveXObject('Scripting.FileSystemObject');
var shell = new ActiveXObject('WScript.Shell');
var stream = new ActiveXObject('ADODB.Stream');
stream.Type = 2;
stream.Charset = 'utf-8';
stream.Open();
stream.LoadFromFile(fso.GetParentFolderName(WScript.ScriptFullName) + '\\\\launcher.json');
var launcher = eval('(' + stream.ReadText() + ')');
stream.Close();
var env = shell.Environment('PROCESS');
env('PATH') = fso.GetParentFolderName(launcher.node) + ';' + env('PATH');
if (launcher.root) env('CMDLESS_ROOT') = launcher.root;
function quote(value) { return '"' + value.replace(/(\\\\*)"/g, '$1$1\\\\"').replace(/(\\\\+)$/, '$1$1') + '"'; }
shell.Run(quote(launcher.node) + ' ' + quote(launcher.bin) + ' launch open ' + quote(WScript.Arguments(0)), 0, false);
`;

const regAdd = (key: string, value: string, type = 'REG_SZ') =>
  execFileSync('reg', ['add', key, '/ve', '/t', type, '/d', value, '/f'], { stdio: 'ignore' });

function registered(root: string) {
  try {
    const out = execFileSync('reg', ['query', `${CLASSES}\\${PROG_ID}\\shell\\open\\command`, '/ve'], { encoding: 'utf8' });
    return out.includes(shimPath(root));
  } catch {
    return false;
  }
}

export const windowsInstalled = (root: string) => fs.existsSync(shimPath(root)) && registered(root);

export async function installWindows(root: string, _launcher: Launcher) {
  fs.writeFileSync(shimPath(root), SHIM);
  const wscript = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wscript.exe');
  regAdd(`${CLASSES}\\.cmdless`, PROG_ID);
  regAdd(`${CLASSES}\\${PROG_ID}`, 'cmdless launch');
  regAdd(`${CLASSES}\\${PROG_ID}\\shell\\open\\command`, `"${wscript}" //B "${shimPath(root)}" "%1"`);
}
