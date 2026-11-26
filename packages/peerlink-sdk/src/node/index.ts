import { connectOrStart, getMetaPackageVersion, getTmpSocketPath, nothingAnswers, resolvePackageExport } from '@cmdless/core/node';
import { connectSocket } from '@cmdless/rpc-sdk/node';
import { peerlinkProtocol } from '../index.js';
import type { OfferParams } from '../index.js';

export * from '../index.js';

// one daemon per user: the socket is both the lock and where clients connect
export function getPeerlinkSocketPath() {
  return getTmpSocketPath(`cmdless-peerlink-${process.getuid?.() ?? process.env.USERNAME ?? 'user'}`);
}

export async function connectPeerlink(address = getPeerlinkSocketPath()) {
  const peer = await connectSocket(peerlinkProtocol, { path: address });
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
export function ensurePeerlink(daemonPath: string) {
  return connectOrStart(connectPeerlink, daemonPath);
}

export type RunPeerlinkOptions = {
  cmdlessRoot?: string;
};

// connects to this device's peerlink, starting it first if nothing answers.
// The daemon comes from the local install when there is one, or else the
// version matching this SDK, installed into the cmdless root. The daemon
// is shared, so one that's already running is used - unless it speaks
// another protocol version, which fails loudly.
export async function runPeerlink(options: RunPeerlinkOptions = {}) {
  try {
    return await connectPeerlink();
  } catch (error) {
    if (!nothingAnswers(error)) throw error;
    const version = await getMetaPackageVersion('@cmdless/peerlink-sdk', import.meta);
    const daemonPath = await resolvePackageExport(import.meta, '@cmdless/peerlink', './daemon', { version, ...options });
    return connectOrStart(connectPeerlink, daemonPath);
  }
}

export type OfferOptions = RunPeerlinkOptions & {
  // false only connects to a running daemon, never starting one
  start?: boolean;
};

export type Offered = {
  id: string;
  // withdraws the offer and closes the connection
  close: () => Promise<void>;
  // the connection ended - whether by close or on its own (peerlink stopped,
  // say), the offer is gone either way
  onClose: (listener: () => void) => void;
};

// offers an address on this device's peerlink, starting it if needed. The
// offer lasts as long as what's returned stays open.
export async function offer(params: OfferParams, options: OfferOptions = {}): Promise<Offered> {
  const { start, ...run } = options;
  const peerlink = start === false ? await connectPeerlink() : await runPeerlink(run);
  try {
    const { id } = await peerlink.request.offer(params);
    let closed = false;
    return {
      id,
      async close() {
        if (closed) return;
        closed = true;
        await peerlink.request.withdraw({ id }).catch(() => { });
        peerlink.dispose();
      },
      onClose: listener => { peerlink.onClose(listener); },
    };
  } catch (error) {
    peerlink.dispose();
    throw error;
  }
}
