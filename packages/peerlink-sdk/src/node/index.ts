import { connectOrStart, getTmpSocketPath } from '@cmdless/core/node';
import { connectSocket } from '@cmdless/rpc-sdk/node';
import { peerlinkProtocol } from '../index.js';

export * from '../index.js';

// one daemon per user: the socket is both the lock and where clients connect
export function getPeerlinkSocketPath() {
  return getTmpSocketPath(`cmdless-peerlink-${process.getuid?.() ?? process.env.USERNAME ?? 'user'}`);
}

export async function connectPeerlink(address = getPeerlinkSocketPath()) {
  const peer = await connectSocket(peerlinkProtocol, { path: address });
  peer.listen();
  return peer;
}

// connects to the running daemon, starting it first (from daemonPath) if
// nothing answers
export function ensurePeerlink(daemonPath: string) {
  return connectOrStart(connectPeerlink, daemonPath);
}
