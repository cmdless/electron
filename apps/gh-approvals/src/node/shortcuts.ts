// The shortcut: a launch (see @cmdless/ui-sdk's Launch) that starts the tray
// with this one's team settings - its provider and owners, never its user,
// whom each person picks for themselves - with a command for each source: npm,
// or the repo itself through gx, which builds it once per commit. Every set in
// it changes nothing when it's run again, so running it while the tray's up
// just brings that up.

import type { Launch, LaunchCommand } from '@cmdless/ui-sdk';
import { providerArgs } from '@cmdless/rtc-sdk/node';
import type { ProviderSettings } from '@cmdless/rtc-sdk/node';

export type ShortcutSettings = {
  appName: string;
  packageName: string;
  // the repo it's in, as gx takes it - none if the package doesn't say
  repo?: string;
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

export function shortcut({ appName, packageName, repo, provider, orgs }: ShortcutSettings): Launch {
  // the settings, then the tray, from one source
  const from = (source: string): LaunchCommand[] => [
    { source, args: ['set', 'provider', ...provider ? providerArgs(provider) : ['none']] },
    ...orgs.map(org => ({ source, args: ['set', 'org', 'add', org] })),
    { source, args: [] },
  ];
  return {
    name: appName,
    sources: {
      npm: { type: 'npm', package: packageName },
      ...repo && { github: { type: 'git', repo, workspace: packageName, build: ['build'] } },
    },
    commands: { npm: from('npm'), ...repo && { GitHub: from('github') } },
  };
}
