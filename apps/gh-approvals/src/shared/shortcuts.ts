// A script that starts the tray the way this one was started - its provider
// set first, then its account and owners - from npm, or from the repo through
// gx, for each platform.

export type Platform = 'windows' | 'macos' | 'linux';
export type Source = 'github' | 'npm';

export const PLATFORMS: { value: Platform; label: string }[] = [
  { value: 'windows', label: 'Windows' },
  { value: 'macos', label: 'macOS' },
  { value: 'linux', label: 'Linux' },
];
export const SOURCES: { value: Source; label: string }[] = [
  { value: 'github', label: 'GitHub (gx)' },
  { value: 'npm', label: 'npm' },
];

// what the tray knows of how it's run: its package, the repo it's in and the
// root script that builds it, this platform, and the set commands that give
// its settings - each one's arguments - before it's run
export type ShortcutSettings = {
  app: string;
  packageName: string;
  repo: string;
  build: string;
  platform: Platform;
  setup: string[][];
};

export const platformOf = (nodePlatform: string): Platform =>
  nodePlatform === 'win32' ? 'windows' : nodePlatform === 'darwin' ? 'macos' : 'linux';

// the repo a package.json's repository names, as gx takes it -
// github:owner/repo for GitHub's
export function repoSpec(repository: string | { url?: string } | undefined) {
  const url = typeof repository === 'string' ? repository : repository?.url;
  if (!url) return undefined;
  const github = /github\.com[/:]([^/]+)\/([^/#]+?)(?:\.git)?(?:#.*)?$/.exec(url);
  return github ? `github:${github[1]}/${github[2]}` : url;
}

// sh quotes what it'd otherwise read as something else
const shQuote = (arg: string) => /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
// cmd quotes what it'd otherwise split (on spaces, commas, = and ;) or read, and a
// script doubles its %
const cmdQuote = (arg: string) => {
  const escaped = arg.replaceAll('%', '%%');
  return /^[\w@+:./\\-]+$/.test(arg) ? escaped : `"${escaped.replaceAll('"', '""')}"`;
};

// the command that runs the app, before its arguments
function command(settings: ShortcutSettings, source: Source) {
  return source === 'npm'
    ? ['npx', '-y', `${settings.packageName}@latest`]
    : ['npx', '-y', '@cmdless/gx', '--build', settings.build, '-w', settings.packageName, settings.repo];
}

// what the script's saved as
export const fileName = (settings: ShortcutSettings, platform: Platform) =>
  `${settings.app}${platform === 'windows' ? '.cmd' : platform === 'macos' ? '.command' : '.sh'}`;

// The script: its settings set - each refused while the tray's already
// running, and then the run joins it - and the tray started
export function shortcut(settings: ShortcutSettings, platform: Platform, source: Source) {
  const base = command(settings, source);
  const from = source === 'npm' ? `${settings.packageName} from npm` : `${settings.packageName} from ${settings.repo}, through gx`;
  if (platform === 'windows') {
    const line = (args: string[]) => [...base, ...args].map(cmdQuote).join(' ');
    return [
      '@echo off',
      `rem ${settings.app}: ${from}`,
      ...settings.setup.map(args => `call ${line(args)}`),
      `call ${line([])}`,
      '',
    ].join('\r\n');
  }
  const line = (args: string[]) => [...base, ...args].map(shQuote).join(' ');
  return [
    '#!/bin/sh',
    `# ${settings.app}: ${from}`,
    ...platform === 'macos' ? ['# double-click it to start the tray (chmod +x it once)'] : ['# chmod +x it once, then run it'],
    ...settings.setup.map(line),
    `exec ${line([])}`,
    '',
  ].join('\n');
}
