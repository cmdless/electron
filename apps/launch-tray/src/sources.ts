// Sources: which are trusted, and how one's bin is run.

import fs from 'node:fs';
import path from 'node:path';
import { describeSource, sourceKey } from '@cmdless/ui-sdk';
import type { LaunchCommand, LaunchSource } from '@cmdless/ui-sdk';

// a command line, as it's run
export type CommandLine = { command: string; args: string[] };

// The trusted sources, by key (sourceKey), each with how it read when it was
// trusted - kept in userData, as trusted.json.
export function trustStore(userData: string) {
  const file = path.join(userData, 'trusted.json');
  const read = (): Record<string, string> => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return {};
    }
  };
  const write = (trusted: Record<string, string>) => fs.writeFileSync(file, `${JSON.stringify(trusted, null, 2)}\n`);
  return {
    all: read,
    has: (source: LaunchSource) => sourceKey(source) in read(),
    trust(sources: LaunchSource[]) {
      write({ ...read(), ...Object.fromEntries(sources.map(source => [sourceKey(source), describeSource(source)])) });
    },
    forget(key: string) {
      const { [key]: _, ...rest } = read();
      write(rest);
    },
  };
}

// a local package's bin: its only one, the one named after it, or the one
// asked for - run with node, as gx and npx would
function localBin(folder: string, asked?: string) {
  const pkg = JSON.parse(fs.readFileSync(path.join(folder, 'package.json'), 'utf8')) as { name?: string; bin?: string | Record<string, string> };
  const unscoped = (pkg.name ?? '').replace(/^@[^/]+\//, '');
  const bins = typeof pkg.bin === 'string' ? { [unscoped]: pkg.bin } : pkg.bin ?? {};
  const names = Object.keys(bins);
  const chosen = asked ?? (names.length === 1 ? names[0] : names.includes(unscoped) ? unscoped : undefined);
  if (chosen === undefined || !(chosen in bins)) {
    throw new Error(`${folder} has ${names.length ? `bins ${names.join(', ')}` : 'no bins'}${asked ? `, not ${asked}` : ' - name one with bin'}`);
  }
  return path.resolve(folder, bins[chosen]);
}

// how a command is run: npm's through npx, a git repo's through gx (which
// clones, installs and builds it once per commit), a folder's with node
export function commandLine(source: LaunchSource, { bin, args }: LaunchCommand): CommandLine {
  switch (source.type) {
    case 'npm': {
      const spec = `${source.package}@${source.version ?? 'latest'}`;
      return { command: 'npx', args: ['-y', ...bin ? ['--package', spec, '--', bin] : [spec], ...args] };
    }
    case 'git':
      return {
        command: 'npx',
        args: [
          '-y', '@cmdless/gx',
          ...source.workspace ? ['-w', source.workspace] : [],
          ...(source.build ?? []).flatMap(script => ['--build', script]),
          ...bin ? ['--bin', bin] : [],
          source.ref ? `${source.repo}#${source.ref}` : source.repo,
          ...args,
        ],
      };
    case 'local':
      return { command: process.execPath, args: [localBin(source.path, bin), ...args] };
  }
}
