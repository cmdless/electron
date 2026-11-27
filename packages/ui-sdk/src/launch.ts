import { defineProtocol } from '@cmdless/rpc-sdk';

// A launch - what a .cmdless file holds: a name, the sources it runs - each a
// package, from npm, a git repo or a folder - and the commands that launch
// it, each one of a source's bins with its arguments, run in order. Named
// lists of commands are choices: prod and dev, say. @cmdless/launch-tray
// runs them, once each source they use is trusted: trusting a source is
// trusting its bins with any arguments.

export type LaunchSource =
  // a package from npm - any version, or this one
  | { type: 'npm'; package: string; version?: string }
  // a package in a git repo, as gx runs it: the repo (github:owner/repo,
  // git+https://...), a ref, the workspace it's in, and the root scripts that
  // build it
  | { type: 'git'; repo: string; ref?: string; workspace?: string; build?: string[] }
  // a package folder on disk
  | { type: 'local'; path: string };

// a source's bin - its only one, or the one named after it, unless bin
// names another - with arguments
export type LaunchCommand = { source: string; bin?: string; args: string[] };

export type Launch = {
  name: string;
  sources: Record<string, LaunchSource>;
  commands: LaunchCommand[] | Record<string, LaunchCommand[]>;
};

const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every(each => typeof each === 'string');
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, what: string) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${what} is missing`);
  return value.trim();
};
const optional = (value: unknown, what: string) => value === undefined ? undefined : text(value, what);

function validSource(name: string, data: unknown): LaunchSource {
  if (!isObject(data)) throw new Error(`source ${name} isn't an object`);
  const what = (field: string) => `source ${name}'s ${field}`;
  switch (data.type) {
    case 'npm': {
      const version = optional(data.version, what('version'));
      return { type: 'npm', package: text(data.package, what('package')), ...version !== undefined && { version } };
    }
    case 'git': {
      const ref = optional(data.ref, what('ref'));
      const workspace = optional(data.workspace, what('workspace'));
      if (data.build !== undefined && !isStrings(data.build)) throw new Error(`${what('build')} isn't a list of scripts`);
      return {
        type: 'git', repo: text(data.repo, what('repo')),
        ...ref !== undefined && { ref }, ...workspace !== undefined && { workspace },
        ...data.build !== undefined && { build: data.build },
      };
    }
    case 'local':
      return { type: 'local', path: text(data.path, what('path')) };
    default:
      throw new Error(`source ${name} is npm, git or local`);
  }
}

function validCommands(data: unknown, sources: Record<string, LaunchSource>, where: string): LaunchCommand[] {
  if (!Array.isArray(data) || data.length === 0) throw new Error(`${where} has no commands`);
  return data.map((each, i) => {
    const at = `${where}'s command ${i + 1}`;
    if (!isObject(each)) throw new Error(`${at} isn't an object`);
    const source = text(each.source, `${at}'s source`);
    if (!(source in sources)) throw new Error(`${at} uses source ${source}, which isn't in sources`);
    const bin = optional(each.bin, `${at}'s bin`);
    const args = each.args ?? [];
    if (!isStrings(args)) throw new Error(`${at}'s args aren't all strings`);
    return { source, ...bin !== undefined && { bin }, args };
  });
}

// a launch, checked - from parsed JSON, or whatever a client sent - throws
// saying what's wrong
export function validLaunch(data: unknown): Launch {
  if (!isObject(data)) throw new Error('a launch is a JSON object');
  const name = text(data.name, 'the launch\'s name');
  if (!isObject(data.sources)) throw new Error('the launch has no sources');
  const sources = Object.fromEntries(Object.entries(data.sources).map(([key, source]) => [key, validSource(key, source)]));
  let commands: Launch['commands'];
  if (Array.isArray(data.commands)) commands = validCommands(data.commands, sources, 'the launch');
  else if (isObject(data.commands) && Object.keys(data.commands).length) {
    commands = Object.fromEntries(Object.entries(data.commands).map(([key, list]) => {
      if (!key.trim()) throw new Error('a command list has no name');
      return [key, validCommands(list, sources, `commands ${key}`)];
    }));
  } else throw new Error('the launch has no commands');
  const used = new Set((Array.isArray(commands) ? commands : Object.values(commands).flat()).map(command => command.source));
  const unused = Object.keys(sources).filter(key => !used.has(key));
  if (unused.length) throw new Error(`no command uses source${unused.length > 1 ? 's' : ''} ${unused.join(', ')}`);
  return { name, sources, commands };
}

// a .cmdless file's text, as a launch
export function parseLaunch(text: string): Launch {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`it isn't JSON: ${(error as Error).message}`);
  }
  return validLaunch(data);
}

// whether two launches say exactly the same
export const sameLaunch = (a: Launch, b: Launch) => JSON.stringify(a) === JSON.stringify(b);

// the names of a launch's command lists - none, for one list
export const commandNames = (launch: Launch) => Array.isArray(launch.commands) ? undefined : Object.keys(launch.commands);

// the commands to run: the launch's one list, or the one named - which a
// launch with named lists needs, and one without can't take
export function commandsFor(launch: Launch, command?: string) {
  if (Array.isArray(launch.commands)) {
    if (command !== undefined) throw new Error(`${launch.name} has no named commands, so not ${command}`);
    return launch.commands;
  }
  if (command === undefined) throw new Error(`${launch.name} needs one of ${Object.keys(launch.commands).join(', ')}`);
  const commands = launch.commands[command];
  if (!commands) throw new Error(`${launch.name} has no commands ${command} - there's ${Object.keys(launch.commands).join(', ')}`);
  return commands;
}

// a GitHub repo however it's written - github:owner/repo, owner/repo, its
// https or ssh URL - as github:owner/repo; any other URL as it is, less a
// git+ prefix and .git suffix
export function repoKey(repo: string) {
  const bare = repo.trim().replace(/#.*$/, '');
  const github = /^(?:github:|(?:git\+)?(?:https?|ssh):\/\/(?:git@)?github\.com\/|git@github\.com:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(bare);
  return github ? `github:${github[1]}/${github[2]}`.toLowerCase() : bare.replace(/^git\+/, '').replace(/\.git\/?$/, '');
}

// what trusting a source trusts: an npm package by name, any version; a
// repo, any ref; a folder - so the same source named differently, or at
// another version or ref, is the same trust
export function sourceKey(source: LaunchSource) {
  switch (source.type) {
    case 'npm': return `npm:${source.package}`;
    case 'git': return `git:${repoKey(source.repo)}`;
    case 'local': return `local:${source.path}`;
  }
}

// a source as it reads, to someone asked to trust it
export function describeSource(source: LaunchSource) {
  switch (source.type) {
    case 'npm': return `${source.package} from npm`;
    case 'git': return `${source.workspace ? `${source.workspace} in ` : ''}${repoKey(source.repo)}`;
    case 'local': return `the package at ${source.path}`;
  }
}

// what adding a launch came to: kept for the first time, kept in place of
// one with its name, or already kept just so
export type AddResult = 'added' | 'replaced' | 'unchanged';

// what opening one came to: running, or turned down - its command not
// chosen, or a source not trusted
export type OpenResult = 'opened' | 'cancelled';

// which of a launch's command lists to run (asked, if it has several and
// none is given), and whether to keep it as well
export type OpenOptions = { command?: string; keep?: boolean };

// what @cmdless/launch-tray serves: one tray per user, on a socket
export const launchProtocol = defineProtocol(({ side, request }) => ({
  // bump only for a change that breaks clients - adding things doesn't
  name: 'launch',
  version: 2,
  clientToServer: side({
    requests: {
      // keeps a launch, under Launch in the tray
      add: request<{ launch: Launch }, AddResult>('launch/add'),
      // runs a launch, asking which commands if it has several and none is
      // given, and to trust any source it uses that isn't - settling once
      // it's running, not once it's done
      open: request<{ launch: Launch } & OpenOptions, OpenResult>('launch/open'),
    },
  }),
}));
