import { defineProtocol } from '@cmdless/rpc-sdk';

// A launch - what a .cmdless file holds: a name, and the commands that
// launch it, run in order. @cmdless/launch-tray keeps the ones that have
// been trusted, and runs them.

export type LaunchCommand = { command: string; args: string[] };
export type Launch = { name: string; commands: LaunchCommand[] };

const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every(each => typeof each === 'string');

// a launch, checked - from parsed JSON, or whatever a client sent - throws
// saying what's wrong
export function validLaunch(data: unknown): Launch {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('a launch is a JSON object');
  const { name, commands } = data as Record<string, unknown>;
  if (typeof name !== 'string' || !name.trim()) throw new Error('the launch has no name');
  if (!Array.isArray(commands) || commands.length === 0) throw new Error('the launch has no commands');
  return {
    name: name.trim(),
    commands: commands.map((each, i) => {
      const { command, args = [] } = (each ?? {}) as Record<string, unknown>;
      if (typeof command !== 'string' || !command.trim()) throw new Error(`command ${i + 1} has no command`);
      if (!isStrings(args)) throw new Error(`command ${i + 1}'s args aren't all strings`);
      return { command, args };
    }),
  };
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

// whether two launches are the same: the same name, running the same
// commands - what trusting one means
export const sameLaunch = (a: Launch, b: Launch) =>
  a.name === b.name && JSON.stringify(a.commands) === JSON.stringify(b.commands);

// how a launch reads, a command to a line - what someone's asked to trust
export const describeLaunch = ({ commands }: Launch) =>
  commands.map(({ command, args }) => [command, ...args].map(arg => /^[\w@%+=:,./-]+$/.test(arg) ? arg : JSON.stringify(arg)).join(' ')).join('\n');

// what adding a launch came to: kept for the first time, kept in place of
// one with its name, already kept just so, or turned down
export type AddResult = 'added' | 'replaced' | 'unchanged' | 'cancelled';

// what opening one came to: running - kept first, if it had to be asked
// about - or turned down
export type OpenResult = 'opened' | 'cancelled';

// what @cmdless/launch-tray serves: one tray per user, on a socket
export const launchProtocol = defineProtocol(({ side, request }) => ({
  // bump only for a change that breaks clients - adding things doesn't
  name: 'launch',
  version: 1,
  clientToServer: side({
    requests: {
      // keeps a launch - asking first, unless it's kept just so already
      add: request<{ launch: Launch }, AddResult>('launch/add'),
      // runs a launch - kept just so, at once; otherwise asked about, and
      // kept, first. Settles once it's running, not once it's done.
      open: request<{ launch: Launch }, OpenResult>('launch/open'),
    },
  }),
}));
