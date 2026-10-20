import type { Dropbox } from './dropbox.js';

// WebRTC's offer and answer, swapped through Dropbox: whoever connects
// writes /signal/<deviceId>/<sessionId>.offer.json, and that device writes
// the .answer.json beside it. ICE isn't trickled - each side gathers every
// candidate first - so it's one file each way.

export const SIGNAL_FOLDER = '/signal';
export const signalFolder = (deviceId: string) => `${SIGNAL_FOLDER}/${deviceId}`;
export const offerPath = (deviceId: string, sessionId: string) => `${signalFolder(deviceId)}/${sessionId}.offer.json`;
export const answerPath = (deviceId: string, sessionId: string) => `${signalFolder(deviceId)}/${sessionId}.answer.json`;

// an offer older than this is left unanswered (and cleaned up)
export const SIGNAL_TTL_MS = 120_000;

export type SignalOffer = { version: 1; sessionId: string; createdAt: string; sdp: string };
export type SignalAnswer = { version: 1; sessionId: string; sdp: string };

// what a data channel opens on the other device: one of its offers, or an
// address one of its offers has (learned through that offer's own protocol)
export type LinkTarget = { offerId: string } | { address: string };

// waits for a file to show up in a folder, using longpoll rather than
// polling, and returns its contents
export async function waitForFile(dropbox: Dropbox, folder: string, path: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  const wanted = path.toLowerCase();
  let { entries, cursor } = await dropbox.listFolder(folder);
  while (!entries.some(entry => entry['.tag'] === 'file' && entry.path_lower === wanted)) {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error('timed out waiting for the other device to answer');
    const { changes, backoff } = await dropbox.longpoll(cursor, Math.max(30, Math.min(60, Math.ceil(left / 1000))));
    if (changes) ({ entries, cursor } = await dropbox.listFolderContinue(cursor));
    else entries = [];
    if (backoff) await new Promise(resolve => setTimeout(resolve, backoff * 1000));
  }
  return dropbox.download(path);
}

// the gathering-complete moment of a peer connection, waited for with a
// cap - whatever candidates there are by then are what gets sent
export function gathered(connection: { iceGatheringState: string }, onChange: (listener: () => void) => void, timeoutMs = 5_000) {
  return new Promise<void>(resolve => {
    if (connection.iceGatheringState === 'complete') return resolve();
    const timer = setTimeout(resolve, timeoutMs);
    onChange(() => {
      if (connection.iceGatheringState !== 'complete') return;
      clearTimeout(timer);
      resolve();
    });
  });
}
