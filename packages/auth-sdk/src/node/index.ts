import { connectOrStart, getTmpSocketPath } from '@cmdless/core/node';
import { connectSocket } from '@cmdless/rpc-sdk/node';
import { authProtocol } from '../index.js';

export * from '../index.js';

// one broker per user: the socket is both the lock and where clients
// connect - and only processes running as this user can reach it
export function getAuthSocketPath() {
  return getTmpSocketPath(`cmdless-auth-${process.getuid?.() ?? process.env.USERNAME ?? 'user'}`);
}

export async function connectAuth(address = getAuthSocketPath()) {
  const peer = await connectSocket(authProtocol, { path: address });
  peer.listen();
  // a daemon that speaks another version fails loudly here, not later
  try {
    await peer.checkVersion();
  } catch (error) {
    peer.dispose();
    throw error;
  }
  return peer;
}

// connects to the running daemon, starting it first (from daemonPath) if
// nothing answers
export function ensureAuth(daemonPath: string) {
  return connectOrStart(connectAuth, daemonPath);
}
