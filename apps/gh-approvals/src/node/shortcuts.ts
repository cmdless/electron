// Shortcuts: launches (see @cmdless/ui-sdk's Launch) that start the tray
// with this one's team settings - its provider and owners, never its user,
// whom each person picks for themselves - from npm, or from the repo through
// gx, which builds it once per commit. Every set in one changes nothing when
// it's run again, so running it while the tray's up just brings that up.

import type { Launch } from '@cmdless/ui-sdk';
import { providerArgs } from '@cmdless/rtc-sdk/node';
import type { ProviderSettings } from '@cmdless/rtc-sdk/node';

export type ShortcutSource = 'npm' | 'gx';

export type ShortcutSettings = {
  appName: string;
  packageName: string;
  // the repo, as gx takes it
  repo: string;
  provider?: ProviderSettings;
  orgs: string[];
};

// the repo a package.json's repository names, as gx takes it -
// github:owner/repo for GitHub's
export function repoSpec(repository: string | { url?: string } | undefined) {
  const url = typeof repository === 'string' ? repository : repository?.url;
  if (!url) return undefined;
  const github = /github\.com[/:]([^/]+)\/([^/#]+?)(?:\.git)?(?:#.*)?$/.exec(url);
  return github ? `github:${github[1]}/${github[2]}` : url;
}

export function shortcut({ appName, packageName, repo, provider, orgs }: ShortcutSettings, source: ShortcutSource): Launch {
  const base = source === 'npm'
    ? ['-y', `${packageName}@latest`]
    : ['-y', '@cmdless/gx', '--build', 'build', '-w', packageName, repo];
  const npx = (...args: string[]) => ({ command: 'npx', args: [...base, ...args] });
  return {
    name: `${appName} (${source === 'npm' ? 'npm' : 'GitHub'})`,
    commands: [
      npx('set', 'provider', ...provider ? providerArgs(provider) : ['none']),
      ...orgs.map(org => npx('set', 'org', 'add', org)),
      npx(),
    ],
  };
}
