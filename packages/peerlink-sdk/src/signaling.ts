// WebRTC's offer and answer, swapped through a provider - in the file
// providers, whoever connects writes /signal/<deviceId>/<sessionId>.offer.json,
// and that device writes the .answer.json beside it. ICE isn't trickled -
// each side gathers every candidate first - so it's one message each way.

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
