#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { connectOrStart, nothingAnswers } from '@cmdless/core/node';
import { connectPeerlink } from '@cmdless/peerlink-sdk/node';
import { accountOf, parseProvider, providerLabel, providerUsage } from '@cmdless/rtc-sdk';
import type { SettingsState, SettingsUpdate } from '@cmdless/peerlink-sdk';
import { ensureAuth } from '@cmdless/auth-sdk/node';
import { defaultSettings, settingsPath, validSettings } from './settings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const daemonPath = path.join(__dirname, 'daemon.js');

const USAGE = `usage: peerlink <command>

  start [--tray | --no-tray]   start the daemon if it isn't running; --tray
                               and --no-tray also set whether it shows a tray
  stop                         stop the daemon
  status                       print the daemon's state
  sign-in                      sign in to the provider's account
  sign-out                     sign out of the provider's account
  set <setting> <value>        change a setting: name, heartbeat (seconds),
                               or tray (true or false)
${providerUsage('set')}

Only start starts the daemon. The rest work on whatever's running - sign-in,
sign-out and set work without it too.`;

type Peerlink = Awaited<ReturnType<typeof connectPeerlink>>;

// the running daemon, or nothing if none is - never starting one
async function running(): Promise<Peerlink | undefined> {
  try {
    return await connectPeerlink();
  } catch (error) {
    if (nothingAnswers(error)) return undefined;
    throw error;
  }
}

// the auth broker, which holds the Dropbox sign-in whether or not peerlink runs
const auth = () => ensureAuth(fileURLToPath(import.meta.resolve('@cmdless/auth/daemon')));

const read = async <T>(channel: { subscribe: (listener: (state: T) => void) => Promise<() => void> }) => {
  let value: T | undefined;
  (await channel.subscribe(state => value = state))();
  return value;
};

// a setting as the command line gives it
function settingFrom([name, value, ...more]: string[]): SettingsUpdate {
  if (name === undefined || value === undefined) throw new Error('set takes a setting and a value');
  switch (name) {
    case 'provider': return validSettings({ provider: parseProvider([value, ...more], to => path.resolve(to)) });
    case 'name': return validSettings({ deviceName: value });
    case 'heartbeat': return validSettings({ heartbeatSeconds: Number(value) });
    case 'tray':
      if (value !== 'true' && value !== 'false') throw new Error('tray is true or false');
      return validSettings({ tray: value === 'true' });
    default: throw new Error(`no setting ${name} - there's name, heartbeat, tray and provider`);
  }
}

// with no daemon to ask, settings.json is changed in place - written beside
// it and renamed over it, as the daemon writes it
async function writeSettings(update: SettingsUpdate) {
  const file = settingsPath();
  const settings = await readSettings();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify({ ...settings, ...update }, null, 2) + '\n');
  await fs.rename(temp, file);
}

// settings.json as it is, with defaults for anything it doesn't have
async function readSettings(): Promise<SettingsState> {
  try {
    return { ...defaultSettings(), ...JSON.parse(await fs.readFile(settingsPath(), 'utf8')) as SettingsState };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return defaultSettings();
  }
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { tray: { type: 'boolean' }, 'no-tray': { type: 'boolean' } },
});
const [command, ...rest] = positionals;

async function main() {
  switch (command) {
    case 'start': {
      let peerlink = await running();
      const wasRunning = !!peerlink;
      peerlink ??= await connectOrStart(connectPeerlink, daemonPath);
      try {
        if (values.tray || values['no-tray']) await peerlink.request.updateSettings({ tray: !!values.tray });
      } finally {
        peerlink.dispose();
      }
      console.log(wasRunning ? 'peerlink is already running' : 'peerlink started');
      return;
    }

    case 'stop': {
      const peerlink = await running();
      if (!peerlink) return console.log('peerlink isn\'t running');
      // stopped once it's gone - its hanging up - not once it's agreed to,
      // so a start straight after doesn't find it still there
      const gone = new Promise<void>(resolve => peerlink.onClose(resolve));
      try {
        await peerlink.request.stop();
        await gone;
      } finally {
        peerlink.dispose();
      }
      console.log('peerlink stopped');
      return;
    }

    case 'status': {
      const peerlink = await running();
      if (!peerlink) {
        console.log(JSON.stringify({ running: false }, null, 2));
        process.exitCode = 1;
        return;
      }
      try {
        const [host, settings, offers, account, devices] = await Promise.all([
          read(peerlink.state.host), read(peerlink.state.settings), read(peerlink.state.offers),
          read(peerlink.state.account), read(peerlink.state.devices),
        ]);
        // addresses carry tokens, so they aren't printed
        const listed = Object.values(offers ?? {}).map(({ id, kind, name }) => ({ id, kind, name }));
        console.log(JSON.stringify({ running: true, host, settings, account, offers: listed, devices }, null, 2));
      } finally {
        peerlink.dispose();
      }
      return;
    }

    case 'sign-in':
    case 'sign-out': {
      // through the daemon when it's there, so its account state follows;
      // straight to the broker otherwise - a daemon started later finds it
      const peerlink = await running();
      if (peerlink) {
        try {
          await (command === 'sign-in' ? peerlink.request.signIn() : peerlink.request.signOut());
        } finally {
          peerlink.dispose();
        }
      } else {
        const { provider } = await readSettings();
        const app = accountOf(provider);
        if (!app) throw new Error(`${providerLabel(provider)} has no account to sign ${command === 'sign-in' ? 'in to' : 'out of'}`);
        const broker = await auth();
        try {
          if (command === 'sign-in') await broker.request.getToken({ provider: app, interactive: true });
          else await broker.request.signOut({ provider: app });
        } finally {
          broker.dispose();
        }
      }
      console.log(command === 'sign-in' ? 'signed in' : 'signed out');
      return;
    }

    case 'set': {
      const update = settingFrom(rest);
      const peerlink = await running();
      if (peerlink) {
        try {
          await peerlink.request.updateSettings(update);
        } finally {
          peerlink.dispose();
        }
      } else {
        await writeSettings(update);
      }
      return;
    }

    default:
      console.error(USAGE);
      process.exitCode = 2;
  }
}

main().catch(error => {
  console.error(`peerlink: ${(error as Error).message}`);
  process.exitCode = 1;
});
