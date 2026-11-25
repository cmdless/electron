import { RTCPeerConnection } from 'werift';
import WebSocket from 'ws';
import { chunked, fromDataChannel, gathered } from '@cmdless/peerlink-sdk';
import type { DataChannelLike, IceServer, LinkTarget, SignalAnswer, SignalingProvider } from '@cmdless/peerlink-sdk';

// how long a peer connection may take to come up after answering
const CONNECT_TIMEOUT_MS = 60_000;

type LinkOptions = {
  provider: SignalingProvider;
  deviceId: string;
  iceServers: () => IceServer[];
  // the local address a channel's target opens, or undefined to refuse it
  resolveTarget: (target: LinkTarget) => string | undefined;
  onError: (error: unknown) => 'stop' | 'retry';
};

// answers the offers other devices send this one through the provider,
// and relays each data channel they open to the address its target resolves
// to - one of this device's offers, never anything else
export function answerLinks(options: LinkOptions) {
  const peers = new Set<RTCPeerConnection>();

  function relay(channel: DataChannelLike & { label: string }) {
    // the connecting side's own channel, which only keeps the link open
    if (channel.label === 'peerlink') return;

    let address: string | undefined;
    try { address = options.resolveTarget(JSON.parse(channel.label) as LinkTarget); } catch { }
    if (!address) {
      channel.close();
      return;
    }

    const pipe = chunked(fromDataChannel(channel));
    const socket = new WebSocket(address);
    // whatever arrives before the socket is open waits for it
    const waiting: string[] = [];
    pipe.onMessage(text => socket.readyState === WebSocket.OPEN ? socket.send(text) : waiting.push(text));
    socket.on('open', () => { for (const text of waiting.splice(0)) socket.send(text); });
    socket.on('message', data => pipe.send(data.toString()));
    socket.on('close', () => channel.close());
    socket.on('error', () => channel.close());
    pipe.onClose(() => socket.close());
  }

  // the answer to one offer - and when its connection has settled, either way
  async function answer(sdp: string) {
    const peer = new RTCPeerConnection({ iceServers: options.iceServers() });
    peers.add(peer);
    peer.onDataChannel.subscribe(channel => relay(channel as unknown as DataChannelLike & { label: string }));

    const settled = new Promise<void>(resolve => {
      const timer = setTimeout(() => void peer.close(), CONNECT_TIMEOUT_MS);
      peer.connectionStateChange.subscribe(state => {
        if (state === 'connected') {
          clearTimeout(timer);
          resolve();
        } else if (state === 'failed' || state === 'closed') {
          clearTimeout(timer);
          peers.delete(peer);
          resolve();
        }
      });
    });

    await peer.setRemoteDescription({ type: 'offer', sdp });
    await peer.setLocalDescription(await peer.createAnswer());
    await gathered(peer, listener => { peer.iceGatheringStateChange.subscribe(() => listener()); });
    return { sdp: peer.localDescription!.sdp, settled };
  }

  const watch = options.provider.answerOffers(options.deviceId, async offer => {
    const { sdp, settled } = await answer(offer.sdp);
    const reply: SignalAnswer = { version: 1, sessionId: offer.sessionId, sdp };
    return { answer: reply, settled };
  }, options.onError);

  return {
    stop() {
      watch.stop();
      for (const peer of peers) void peer.close();
      peers.clear();
    },
  };
}
