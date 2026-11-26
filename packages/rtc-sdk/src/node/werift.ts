import { RTCPeerConnection } from 'werift';
import type { RTCDataChannel } from 'werift';
import { gathered, KEEPALIVE_LABEL } from '../rtc.js';
import type { RtcDataChannel, RtcState, WebRtc } from '../rtc.js';

// a channel, once it's open
function opened(channel: RTCDataChannel) {
  return new Promise<RTCDataChannel>((resolve, reject) => {
    const check = (state: string) => {
      if (state === 'open') resolve(channel);
      else if (state === 'closed') reject(new Error(`the other device closed ${channel.label}`));
    };
    channel.stateChanged.subscribe(check);
    check(channel.readyState);
  });
}

// WebRTC in node: werift, all JavaScript. werift's close doesn't tell the
// other side, so each channel is closed first - and the keepalive channel
// closing is the connection closing, whichever side closed it.
export const werift: WebRtc = {
  createPeer(iceServers) {
    const peer = new RTCPeerConnection({ iceServers });
    const gather = () => gathered(peer, listener => { peer.iceGatheringStateChange.subscribe(() => listener()); });
    const channels = new Set<RTCDataChannel>();
    const listeners: ((state: RtcState) => void)[] = [];
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      for (const channel of channels) channel.close();
      void peer.close();
      for (const listener of listeners) listener('closed');
    };
    const keep = (channel: RTCDataChannel) => {
      channels.add(channel);
      channel.stateChanged.subscribe(state => {
        if (state !== 'closed') return;
        channels.delete(channel);
        if (channel.label === KEEPALIVE_LABEL) end();
      });
      return channel;
    };
    peer.connectionStateChange.subscribe(state => {
      if (ended) return;
      if (state === 'failed' || state === 'closed') return end();
      for (const listener of listeners) listener(state as RtcState);
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
      openChannel: async label => await opened(keep(peer.createDataChannel(label))) as unknown as RtcDataChannel,
      onChannel(listener) {
        // handed on once it's open - werift opens it just after telling
        peer.onDataChannel.subscribe(channel => {
          keep(channel);
          if (channel.label === KEEPALIVE_LABEL) return;
          opened(channel).then(open => listener(open as unknown as RtcDataChannel), () => { });
        });
      },
      get state() { return ended ? 'closed' : peer.connectionState as RtcState; },
      onState(listener) { listeners.push(listener); },
      close: end,
    };
  },
};
