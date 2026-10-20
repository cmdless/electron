import { RTCPeerConnection } from 'werift';
import WebSocket from 'ws';
import {
  answerPath, chunked, DropboxError, fromDataChannel, gathered, offerPath, signalFolder, SIGNAL_TTL_MS,
} from '@cmdless/peerlink-sdk';
import type { DataChannelLike, Dropbox, IceServer, LinkTarget, SignalAnswer, SignalOffer } from '@cmdless/peerlink-sdk';

// how long a peer connection may take to come up after answering
const CONNECT_TIMEOUT_MS = 60_000;
const RETRY_MS = 10_000;

type LinkOptions = {
  dropbox: Dropbox;
  deviceId: string;
  iceServers: () => IceServer[];
  // the local address a channel's target opens, or undefined to refuse it
  resolveTarget: (target: LinkTarget) => string | undefined;
  onError: (error: unknown) => 'stop' | 'retry';
};

// answers the offers other devices write to this device's signal folder,
// and relays each data channel they open to the address its target resolves
// to - one of this device's offers, never anything else
export function answerLinks(options: LinkOptions) {
  const { dropbox, deviceId } = options;
  const folder = signalFolder(deviceId);
  const peers = new Set<RTCPeerConnection>();
  const answered = new Set<string>();
  let running = true;
  let poll: AbortController | undefined;
  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  const cleanUp = (sessionId: string) => Promise.allSettled([
    dropbox.remove(offerPath(deviceId, sessionId)),
    dropbox.remove(answerPath(deviceId, sessionId)),
  ]);

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

  async function answer(sessionId: string) {
    const offer = JSON.parse(await dropbox.download(offerPath(deviceId, sessionId))) as SignalOffer;
    if (Date.now() - Date.parse(offer.createdAt) > SIGNAL_TTL_MS) {
      await cleanUp(sessionId);
      return;
    }

    const peer = new RTCPeerConnection({ iceServers: options.iceServers() });
    peers.add(peer);
    peer.onDataChannel.subscribe(channel => relay(channel as unknown as DataChannelLike & { label: string }));

    const timer = setTimeout(() => void peer.close(), CONNECT_TIMEOUT_MS);
    peer.connectionStateChange.subscribe(state => {
      if (state === 'connected') {
        clearTimeout(timer);
        void cleanUp(sessionId);
      } else if (state === 'failed' || state === 'closed') {
        clearTimeout(timer);
        peers.delete(peer);
        void cleanUp(sessionId);
      }
    });

    await peer.setRemoteDescription({ type: 'offer', sdp: offer.sdp });
    await peer.setLocalDescription(await peer.createAnswer());
    await gathered(peer, listener => { peer.iceGatheringStateChange.subscribe(() => listener()); });
    const reply: SignalAnswer = { version: 1, sessionId, sdp: peer.localDescription!.sdp };
    await dropbox.upload(answerPath(deviceId, sessionId), JSON.stringify(reply));
  }

  function handle(paths: string[]) {
    for (const path of paths) {
      const match = /\/([^/]+)\.offer\.json$/.exec(path);
      if (!match || answered.has(match[1])) continue;
      answered.add(match[1]);
      answer(match[1]).catch(error => console.error(`peerlink: couldn't answer ${match[1]}:`, error));
    }
  }

  void (async () => {
    while (running) {
      try {
        let listed;
        try {
          listed = await dropbox.listFolder(folder);
        } catch (error) {
          // nobody has tried to connect to this device yet
          if (error instanceof DropboxError && error.status === 409 && error.summary.includes('not_found')) {
            await wait(RETRY_MS);
            continue;
          }
          throw error;
        }
        let { cursor } = listed;
        handle(listed.entries.filter(entry => entry['.tag'] === 'file').map(entry => entry.path_lower));

        while (running) {
          poll = new AbortController();
          const { changes, backoff } = await dropbox.longpoll(cursor, 60, poll.signal);
          if (changes) {
            const next = await dropbox.listFolderContinue(cursor);
            cursor = next.cursor;
            handle(next.entries.filter(entry => entry['.tag'] === 'file').map(entry => entry.path_lower));
          }
          if (backoff) await wait(backoff * 1000);
        }
      } catch (error) {
        if (!running) return;
        if (options.onError(error) === 'stop') { stop(); return; }
        await wait(RETRY_MS);
      }
    }
  })();

  function stop() {
    running = false;
    poll?.abort();
    for (const peer of peers) void peer.close();
    peers.clear();
  }

  return { stop };
}
