// What devices tell each other through a provider: each one's advertisement,
// and WebRTC's offer and answer for each connection. ICE isn't trickled -
// each side gathers every candidate first - so a connection is one message
// each way.

export type IceServer = { urls: string | string[]; username?: string; credential?: string };

// a device as it advertises itself: who it is, whether it's there, how to
// reach it, and whatever its host says about it (info)
export type Advertisement<Info = unknown> = {
  version: 2;
  deviceId: string;
  name: string;
  updatedAt: string;
  // how often it's rewritten while nothing changes - a device is offline
  // once it misses three
  heartbeatSeconds: number;
  // false once its host stopped cleanly
  online: boolean;
  // the STUN/TURN servers to reach it with
  iceServers: IceServer[];
  info: Info;
};

// another device, as a host sees it
export type Device<Info = unknown> = {
  name: string;
  updatedAt: string;
  online: boolean;
  iceServers: IceServer[];
  info: Info;
};

// whether an advertisement says its device is there now
export function isOnline(advertisement: Pick<Advertisement, 'online' | 'updatedAt' | 'heartbeatSeconds'>, now = Date.now()) {
  return advertisement.online && now - Date.parse(advertisement.updatedAt) < advertisement.heartbeatSeconds * 3_000;
}

// an offer to connect, from one device to another; from is who it says it's
// from - a provider's own trust is all that vouches for it
export type SignalOffer = { version: 2; sessionId: string; from: string; createdAt: string; sdp: string };
export type SignalAnswer = { version: 2; sessionId: string; sdp: string };

// an offer older than this is left unanswered (and cleaned up)
export const SIGNAL_TTL_MS = 120_000;

// where the file providers keep them:
//
//   /devices/<deviceId>.json                    each device's advertisement
//   /signal/<deviceId>/<sessionId>.offer.json   an offer to that device
//   /signal/<deviceId>/<sessionId>.answer.json  its answer
export const DEVICES_FOLDER = '/devices';
export const advertisementPath = (deviceId: string) => `${DEVICES_FOLDER}/${deviceId}.json`;
export const SIGNAL_FOLDER = '/signal';
export const signalFolder = (deviceId: string) => `${SIGNAL_FOLDER}/${deviceId}`;
export const offerPath = (deviceId: string, sessionId: string) => `${signalFolder(deviceId)}/${sessionId}.offer.json`;
export const answerPath = (deviceId: string, sessionId: string) => `${signalFolder(deviceId)}/${sessionId}.answer.json`;
