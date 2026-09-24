#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { findPackageJSON } from 'node:module';

const [, , pkgPath, mode] = process.argv;
if (!pkgPath) throw new Error('usage: pin-workspace-deps.mjs <path-to-package.json> [--range]');
if (mode !== undefined && mode !== '--range') throw new Error(`unknown mode: ${mode}`);

const base = pathToFileURL(path.resolve(pkgPath));
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

for (const [name, range] of Object.entries(pkg.dependencies ?? {})) {
  if (range !== '*') continue;

  const depPkgPath = findPackageJSON(name, base);
  if (!depPkgPath) throw new Error(`could not resolve ${name} from ${pkgPath}`);

  const { version } = JSON.parse(fs.readFileSync(depPkgPath, 'utf8'));
  const pinned = mode === '--range' ? `^${version}` : version;
  pkg.dependencies[name] = pinned;
  console.log(`pinned ${name} -> ${pinned}`);
}

fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
