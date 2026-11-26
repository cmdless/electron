import { RTCPeerConnection } from 'node-datachannel/polyfill';
import { createHost } from '../host.js';
import type { RtcHostOptions } from '../host.js';
import type { SignalingProvider } from '../providers.js';
import { w3cRtc } from '../w3c.js';

export * from '../index.js';
export * from './folder.js';

// WebRTC in node: node-datachannel's standard RTCPeerConnection, over
// libdatachannel - the standard one in all but its event classes' types
export const nodeRtc = w3cRtc(RTCPeerConnection as unknown as typeof globalThis.RTCPeerConnection);

// a host on a provider, with node's WebRTC
export function createRtcHost<Info>(provider: SignalingProvider, options: RtcHostOptions<Info>) {
  return createHost(nodeRtc, provider, options);
}
