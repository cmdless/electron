import { createHost } from '../host.js';
import type { RtcHostOptions } from '../host.js';
import type { SignalingProvider } from '../providers.js';
import { w3cRtc } from '../w3c.js';

export * from '../index.js';

// the browser's own WebRTC
export const nativeRtc = w3cRtc(RTCPeerConnection);

// a host on a provider, with the browser's WebRTC - a tab can be a device as
// fully as anything else, for as long as it's open
export function createRtcHost<Info>(provider: SignalingProvider, options: RtcHostOptions<Info>) {
  return createHost(nativeRtc, provider, options);
}
