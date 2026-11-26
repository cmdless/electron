import { gathered, KEEPALIVE_LABEL } from './rtc.js';
import type { RtcDataChannel, RtcState, WebRtc } from './rtc.js';

// a channel, once it's open
function opened(channel: RTCDataChannel) {
  return new Promise<RtcDataChannel>((resolve, reject) => {
    if (channel.readyState === 'open') return resolve(channel);
    channel.addEventListener('open', () => resolve(channel), { once: true });
    channel.addEventListener('close', () => reject(new Error(`the other device closed ${channel.label}`)), { once: true });
  });
}

// WebRTC from a standard RTCPeerConnection - the browser's own, or
// node-datachannel's in node. Each channel is closed before the connection,
// so the other side hears it, and the keepalive channel closing is the
// connection closing, whichever side closed it.
export function w3cRtc(PeerConnection: new (config: RTCConfiguration) => RTCPeerConnection): WebRtc {
  return {
    createPeer(iceServers) {
      const peer = new PeerConnection({ iceServers });
      const gather = () => gathered(peer, listener => peer.addEventListener('icegatheringstatechange', listener));
      const channels = new Set<RTCDataChannel>();
      const listeners: ((state: RtcState) => void)[] = [];
      let ended = false;
      const end = () => {
        if (ended) return;
        ended = true;
        for (const channel of channels) channel.close();
        peer.close();
        for (const listener of listeners) listener('closed');
      };
      const keep = (channel: RTCDataChannel) => {
        channels.add(channel);
        channel.addEventListener('close', () => {
          channels.delete(channel);
          if (channel.label === KEEPALIVE_LABEL) end();
        });
        return channel;
      };
      peer.addEventListener('connectionstatechange', () => {
        if (ended) return;
        const state = peer.connectionState as RtcState;
        if (state === 'failed' || state === 'closed') return end();
        for (const listener of listeners) listener(state);
      });

      return {
        async offer() {
          keep(peer.createDataChannel(KEEPALIVE_LABEL));
          await peer.setLocalDescription(await peer.createOffer());
          await gather();
          return peer.localDescription!.sdp;
        },
        async answer(sdp) {
          await peer.setRemoteDescription({ type: 'offer', sdp });
          await peer.setLocalDescription(await peer.createAnswer());
          await gather();
          return peer.localDescription!.sdp;
        },
        async accept(sdp) {
          await peer.setRemoteDescription({ type: 'answer', sdp });
        },
        openChannel: label => opened(keep(peer.createDataChannel(label))),
        // handed on once it's open - sends before then are lost
        onChannel(listener) {
          peer.addEventListener('datachannel', ({ channel }) => {
            keep(channel);
            if (channel.label === KEEPALIVE_LABEL) return;
            opened(channel).then(listener, () => { });
          });
        },
        get state() { return ended ? 'closed' : peer.connectionState as RtcState; },
        onState(listener) { listeners.push(listener); },
        close: end,
      };
    },
  };
}
