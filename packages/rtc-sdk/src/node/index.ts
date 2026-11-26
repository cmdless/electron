import { createHost } from '../host.js';
import type { RtcHostOptions } from '../host.js';
import type { SignalingProvider } from '../providers.js';
import { werift } from './werift.js';

export * from '../index.js';
export * from './folder.js';
export { werift };

// a host on a provider, with werift's WebRTC
export function createRtcHost<Info>(provider: SignalingProvider, options: RtcHostOptions<Info>) {
  return createHost(werift, provider, options);
}
