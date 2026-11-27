import { connectOrStart, getTmpSocketPath, resolveNewestPackageBin } from '@cmdless/core/node';
import { connectSocket } from '@cmdless/rpc-sdk/node';
import { launchProtocol } from '../launch.js';
import type { Launch, OpenOptions } from '../launch.js';

// one launch tray per user: its socket is both its lock and where clients
// connect - and only processes running as this user can reach it
export function getLaunchSocketPath() {
  return getTmpSocketPath(`cmdless-launch-${process.getuid?.() ?? process.env.USERNAME ?? 'user'}`);
}

async function connectLaunch(address = getLaunchSocketPath()) {
  const peer = await connectSocket(launchProtocol, { path: address });
  peer.listen();
  // a tray that speaks another version fails loudly here, not later
  try {
    await peer.checkVersion();
  } catch (error) {
    peer.dispose();
    throw error;
  }
  return peer;
}

export type LaunchHostOptions = { cmdlessRoot?: string };


// A connection to @cmdless/launch-tray - the running one, or one started for
// it: the newest version already cached, or the latest from npm when there's
// none. Nothing updates what's cached.
export class LaunchHost {
  private constructor(private readonly client: Awaited<ReturnType<typeof connectLaunch>>) { }

  static async create({ cmdlessRoot }: LaunchHostOptions = {}) {
    const { binPath } = await resolveNewestPackageBin(import.meta, '@cmdless/launch-tray', cmdlessRoot);
    return new LaunchHost(await connectOrStart(connectLaunch, binPath));
  }

  // keeps a launch, under Launch in the tray
  add(launch: Launch) {
    return this.client.request.add({ launch });
  }

  // runs a launch - its commands, or the ones named (asked, if it has
  // several and none's named), keeping it too with keep - settling once
  // it's running
  open(launch: Launch, options: OpenOptions = {}) {
    return this.client.request.open({ launch, ...options });
  }

  dispose() {
    this.client.dispose();
  }

  // the one-shots: connect, ask, leave
  static async add(launch: Launch, options: LaunchHostOptions = {}) {
    const host = await LaunchHost.create(options);
    try {
      return await host.add(launch);
    } finally {
      host.dispose();
    }
  }

  static async open(launch: Launch, { cmdlessRoot, ...options }: LaunchHostOptions & OpenOptions = {}) {
    const host = await LaunchHost.create({ cmdlessRoot });
    try {
      return await host.open(launch, options);
    } finally {
      host.dispose();
    }
  }
}
