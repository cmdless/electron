import { chunked, fromDataChannel, pipeConnection } from '../pipes.js';
import { answerPath, gathered, offerPath, signalFolder, waitForFile } from '../signaling.js';
import type { LinkTarget, SignalAnswer, SignalOffer } from '../signaling.js';
import type { Dropbox } from '../dropbox.js';
import type { IceServer } from '../index.js';

export type ConnectOptions = {
  // the device's own, from its advertisement
  iceServers: IceServer[];
  // how long to wait for the device to answer through Dropbox
  answerTimeoutMs?: number;
  // how long to wait for the connection itself once it has
  connectTimeoutMs?: number;
};

export type DeviceLink = Awaited<ReturnType<typeof connectDevice>>;

// a peer connection to another device, signaled through Dropbox. Each open
// is its own data channel, relayed by that device to one of its offers.
export async function connectDevice(dropbox: Dropbox, deviceId: string, options: ConnectOptions) {
  const { iceServers, answerTimeoutMs = 60_000, connectTimeoutMs = 20_000 } = options;
  const peer = new RTCPeerConnection({ iceServers });
  const sessionId = crypto.randomUUID();

  try {
    // a channel has to exist before the offer, or it carries no data
    // channels at all - this one just stays open with the connection
    peer.createDataChannel('peerlink');
    await peer.setLocalDescription(await peer.createOffer());
    await gathered(peer, listener => peer.addEventListener('icegatheringstatechange', listener));

    const offer: SignalOffer = { version: 1, sessionId, createdAt: new Date().toISOString(), sdp: peer.localDescription!.sdp };
    await dropbox.upload(offerPath(deviceId, sessionId), JSON.stringify(offer));
    const answer = JSON.parse(await waitForFile(dropbox, signalFolder(deviceId), answerPath(deviceId, sessionId), answerTimeoutMs)) as SignalAnswer;
    await peer.setRemoteDescription({ type: 'answer', sdp: answer.sdp });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the connection didn\'t come up - the networks between may need a TURN server')), connectTimeoutMs);
      const check = () => {
        if (peer.connectionState === 'connected') { clearTimeout(timer); resolve(); }
        else if (peer.connectionState === 'failed') { clearTimeout(timer); reject(new Error('the connection failed')); }
      };
      peer.addEventListener('connectionstatechange', check);
      check();
    });
  } catch (error) {
    peer.close();
    throw error;
  }

  return {
    // a JSON-RPC connection to target on that device - hand it to any
    // protocol's createClient
    async open(target: LinkTarget) {
      const channel = peer.createDataChannel(JSON.stringify(target));
      await new Promise<void>((resolve, reject) => {
        channel.onopen = () => resolve();
        channel.onerror = () => reject(new Error('the device refused the channel'));
        channel.addEventListener('close', () => reject(new Error('the device closed the channel')), { once: true });
      });
      return pipeConnection(chunked(fromDataChannel(channel)));
    },
    onClose(listener: () => void) {
      peer.addEventListener('connectionstatechange', () => {
        if (['closed', 'failed', 'disconnected'].includes(peer.connectionState)) listener();
      });
    },
    close: () => peer.close(),
  };
}
