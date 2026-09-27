#!/usr/bin/env node
import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const srcDir = path.resolve('src');
const files = readdirSync(srcDir, { recursive: true })
  .filter(file => file.endsWith('.test.ts'))
  .map(file => path.join('src', file));

// tests under src/browser rely on packages (e.g. vscode-jsonrpc's ./browser
// export) that are only reachable under the "browser" export condition,
// which bundlers set automatically but plain node doesn't. Everything else
// must run WITHOUT that condition - e.g. the `ws` package's own browser
// export doesn't provide WebSocketServer at all.
const browserFiles = files.filter(file => file.startsWith(`src${path.sep}browser${path.sep}`));
const otherFiles = files.filter(file => !browserFiles.includes(file));

if (otherFiles.length > 0)
  execFileSync(process.execPath, ['--test', '--import', 'tsx', ...otherFiles], { stdio: 'inherit' });

if (browserFiles.length > 0)
  execFileSync(process.execPath, ['--test', '--conditions', 'browser', '--import', 'tsx', ...browserFiles], { stdio: 'inherit' });
