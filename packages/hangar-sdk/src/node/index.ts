import { getTmpSocketPath, waitForService } from '@cmdless/core/node';
import { connectSocket } from '@cmdless/rpc-sdk/node';
import { hangarProtocol } from '../index.js';
import type { HangarService } from '../index.js';

export * from '../index.js';

// one daemon per user and name: the socket is both the lock (only one
// process can listen on it) and where hangar clients connect.
export function getHangarSocketPath(name = 'hangar') {
  return getTmpSocketPath(`cmdless-${name}-${process.getuid?.() ?? process.env.USERNAME ?? 'user'}`);
}

export async function connectHangar(address = getHangarSocketPath()) {
  const peer = await connectSocket(hangarProtocol, { path: address });
  peer.listen();
  return peer;
}

// connects to the running daemon, starting it first (from daemonPath) if
// nothing answers
export async function ensureHangar(daemonPath: string) {
  try {
    return await connectHangar();
  } catch {
    const { value } = await waitForService<HangarService>(process.execPath, [daemonPath]);
    return connectHangar(value.address);
  }
}
