import type { DataChannelLike } from './pipes.js';
import type { IceServer } from './signaling.js';

// The WebRTC a host needs, from whichever implementation there is - the
// browser's own, or werift in node. Each side's description is complete
// (every candidate gathered) before it's handed over.
export type WebRtc = { createPeer(iceServers: IceServer[]): RtcPeer };

export type RtcState = 'new' | 'connecting' | 'connected' | 'disconnected' | 'failed' | 'closed';

export type RtcDataChannel = DataChannelLike & { label: string };

export type RtcPeer = {
  // as the side that connects: an offer to send
  offer(): Promise<string>;
  // as the side connected to: the answer to an offer
  answer(offerSdp: string): Promise<string>;
  // the answer to this side's offer
  accept(answerSdp: string): Promise<void>;
  // a channel this side opens, once it's open
  openChannel(label: string): Promise<RtcDataChannel>;
  // each channel the other side opens, once it's open - never the keepalive
  onChannel(listener: (channel: RtcDataChannel) => void): void;
  readonly state: RtcState;
  onState(listener: (state: RtcState) => void): void;
  close(): void;
};

// the channel the connecting side opens before its offer - an offer with no
// channel carries no data channels at all. It's never handed on: it's there
// for the connection's lifetime, and its closing (from either side) is the
// connection closing.
export const KEEPALIVE_LABEL = 'rtc-sdk';

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
