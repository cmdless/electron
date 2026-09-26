#!/usr/bin/env node
import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const srcDir = path.resolve('src');
const files = readdirSync(srcDir, { recursive: true })
  .filter(file => file.endsWith('.test.ts'))
  .map(file => path.join('src', file));

if (files.length > 0)
  execFileSync(process.execPath, ['--test', '--import', 'tsx', ...files], { stdio: 'inherit' });
