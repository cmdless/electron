import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { SHIM } from './launch-windows.js';
import { desktopEntry, MIME_XML } from './launch-linux.js';

// the Windows and Linux launchers can't be run here - what they write can
// be checked

test('hidden.js parses, and quotes as Windows splits arguments', () => {
  new vm.Script(SHIM);
  const quote = new vm.Script(`${SHIM.match(/function quote[^\n]+/)![0]}; quote`).runInNewContext() as (value: string) => string;
  assert.equal(quote('C:\\Program Files\\nodejs\\node.exe'), '"C:\\Program Files\\nodejs\\node.exe"');
  assert.equal(quote('C:\\a "b".cmdless'), '"C:\\a \\"b\\".cmdless"');
  assert.equal(quote('C:\\dir\\'), '"C:\\dir\\\\"');
});

test('the desktop entry quotes its Exec as the spec asks', () => {
  assert.match(desktopEntry('/home/me/odd $dir "x" 100%'), /^Exec="\/home\/me\/odd \\\$dir \\"x\\" 100%%\/launcher" %f$/m);
  assert.match(MIME_XML, /<glob pattern="\*\.cmdless"\/>/);
});
