#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const [, , pkgPath] = process.argv;
if (!pkgPath) throw new Error('usage: verify-pack.mjs <path-to-package.json>');

const pkgDir = path.dirname(path.resolve(pkgPath));
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

function collectPaths(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) collectPaths(v, out);
  return out;
}

const declared = [...new Set([
  ...collectPaths(pkg.bin),
  ...collectPaths(pkg.exports),
  ...(pkg.main ? [pkg.main] : []),
])].map(p => path.normalize(p.replace(/^\.\//, '')));

if (declared.length === 0) {
  console.log(`${pkg.name}: no bin/exports/main entries declared, nothing to verify.`);
  process.exit(0);
}

const [{ files }] = JSON.parse(
  execFileSync('npm', ['pack', '--dry-run', '--json', `--workspace=${pkg.name}`]).toString()
);
const packed = new Set(files.map(f => path.normalize(f.path)));

const missing = declared.filter(p => !packed.has(p));
if (missing.length) {
  console.error(`${pkg.name}: declared entry point(s) missing from packed output:\n  ${missing.join('\n  ')}`);
  process.exit(1);
}
console.log(`${pkg.name}: all ${declared.length} declared entry point(s) present in packed output.`);

for (const rel of declared) {
  if (!/\.(m?js|cjs)$/.test(rel)) continue;
  execFileSync('node', ['--check', rel], { cwd: pkgDir });
}
console.log(`${pkg.name}: all JS entry points pass a syntax check.`);
