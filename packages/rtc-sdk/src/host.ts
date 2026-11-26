import { chunked, fromDataChannel, pipeConnection } from './pipes.js';
import type { Pipe } from './pipes.js';
import type { SignalingProvider } from './providers.js';
import type { RtcPeer, RtcState, WebRtc } from './rtc.js';
import type { Advertisement, Device, IceServer } from './signaling.js';

export const DEFAULT_ICE_SERVERS: IceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];
export const DEFAULT_HEARTBEAT_SECONDS = 60;

// how long a connection may take to come up once its answer is out
const ANSWERED_TIMEOUT_MS = 60_000;

// a data channel between two devices: whole messages either way (however
// big), and the same as a JSON-RPC connection - any protocol's server or
// client runs on it
export type RtcChannel = {
  label: string;
  pipe: Pipe;
  connection(): ReturnType<typeof pipeConnection>;
};

// a channel another device opened to this one
export type IncomingChannel = RtcChannel & {
  // the device it came from, as its offer said - the provider's own trust
  // is all that vouches for it
  from: string;
};

// a connection to another device: open as many channels on it as you like
export type RtcLink = {
  deviceId: string;
  open(label: string): Promise<RtcChannel>;
  // called once, when it's gone - closed by either side, or lost
  onClose(listener: () => void): void;
  close(): void;
};

export type RtcHostOptions<Info> = {
  deviceId: string;
  name: string;
  // what this device says about itself, for the others to read
  info?: Info;
  iceServers?: IceServer[];
  // how often the advertisement is rewritten while nothing changes
  heartbeatSeconds?: number;
  // false: watch the others and connect to them, without being seen
  publish?: boolean;
  // each channel another device opens - false (or a throw) closes it. Left
  // out, this host doesn't answer anyone.
  accept?: (channel: IncomingChannel) => boolean | void;
  onDevices?: (devices: Record<string, Device<Info>>) => void;
  // something failing that it's waiting out - undefined once it's caught up
  onError?: (reason: string | undefined) => void;
  // something failing that only a person can get past (a sign-in, say):
  // the host has stopped
  onStopped?: (reason: string) => void;
};

export type ConnectOptions = {
  // how long the device gets to answer through the provider
  answerTimeoutMs?: number;
  // how long the connection gets to come up once it has
  connectTimeoutMs?: number;
};

export type RtcHost<Info> = {
  readonly deviceId: string;
  // the other devices, by id
  readonly devices: Record<string, Device<Info>>;
  onDevices(listener: (devices: Record<string, Device<Info>>) => void): () => void;
  connect(deviceId: string, options?: ConnectOptions): Promise<RtcLink>;
  // changes what it advertises - written right away
  update(changes: Partial<Pick<RtcHostOptions<Info>, 'name' | 'info' | 'iceServers' | 'heartbeatSeconds'>>): void;
  // ends it: every connection closes, and (unless offline is false) the
  // others are told it's gone rather than left to notice
  stop(options?: { offline?: boolean }): Promise<void>;
};

const channelOf = (label: string, pipe: Pipe): RtcChannel => {
  const whole = chunked(pipe);
  return { label, pipe: whole, connection: () => pipeConnection(whole) };
};

// The first message on a channel is the accepting side's verdict - so a
// refused channel is closed by whoever opened it, never by the side it
// reached the moment it arrived, before the opener knows whether to send.
const ACCEPTED = 'accepted';
const REFUSED = 'refused';

// a pipe whose sends wait until it's released - what accept sends goes after
// the verdict
function held(pipe: Pipe) {
  let waiting: string[] | undefined = [];
  return {
    pipe: { ...pipe, send: (text: string) => waiting ? void waiting.push(text) : pipe.send(text) },
    release() {
      const sends = waiting ?? [];
      waiting = undefined;
      for (const text of sends) pipe.send(text);
    },
  };
}

// the verdict on a channel this side opened, and everything after it
function verdict(pipe: Pipe) {
  const listeners: ((text: string) => void)[] = [];
  let first = true;
  let decide!: (accepted: boolean) => void;
  let fail!: (error: Error) => void;
  const accepted = new Promise<boolean>((resolve, reject) => { decide = resolve; fail = reject; });
  pipe.onMessage(text => {
    if (!first) return void listeners.forEach(listener => listener(text));
    first = false;
    decide(text === ACCEPTED);
  });
  pipe.onClose(() => fail(new Error('the channel closed before it was accepted')));
  return { accepted, pipe: { ...pipe, onMessage: (listener: (text: string) => void) => { listeners.push(listener); } } };
}

const reasonOf = (error: unknown) => String((error as Error)?.message ?? error);

// a device on a provider: it advertises itself (with a heartbeat), keeps up
// with the others, answers whoever connects to it, and connects to them
export function createHost<Info>(webrtc: WebRtc, provider: SignalingProvider, options: RtcHostOptions<Info>): RtcHost<Info> {
  const { deviceId } = options;
  const publishes = options.publish !== false;
  const self = {
    name: options.name,
    info: options.info as Info,
    iceServers: options.iceServers ?? DEFAULT_ICE_SERVERS,
    heartbeatSeconds: options.heartbeatSeconds ?? DEFAULT_HEARTBEAT_SECONDS,
  };
  let devices: Record<string, Device<Info>> = {};
  const listeners = new Set<(devices: Record<string, Device<Info>>) => void>();
  if (options.onDevices) listeners.add(options.onDevices);
  const peers = new Set<RtcPeer>();
  let running = true;

  const failed = (error: unknown): 'stop' | 'retry' => {
    if (provider.needsPerson(error)) {
      void stop({ offline: false });
      options.onStopped?.(reasonOf(error));
      return 'stop';
    }
    options.onError?.(reasonOf(error));
    return 'retry';
  };

  // a peer connection, kept until it's over
  const track = (peer: RtcPeer) => {
    peers.add(peer);
    peer.onState(state => { if (state === 'failed' || state === 'closed') peers.delete(peer); });
    return peer;
  };

  // presence: one write at a time, always of this device as it is then
  const advertisement = (online: boolean): Advertisement<Info> => ({
    version: 2,
    deviceId,
    name: self.name,
    updatedAt: new Date().toISOString(),
    heartbeatSeconds: self.heartbeatSeconds,
    online,
    iceServers: self.iceServers,
    info: self.info,
  });
  let publishing: Promise<void> = Promise.resolve();
  const publish = (online = true) => {
    publishing = publishing.catch(() => { }).then(() => provider.publish(advertisement(online)));
    return publishing;
  };
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const beat = () => {
    clearInterval(heartbeat);
    heartbeat = setInterval(() => { publish().catch(failed); }, self.heartbeatSeconds * 1000);
  };
  if (publishes) {
    beat();
    // written first, so the others see this device straight away
    publish().catch(failed);
  }

  const watch = provider.watchDevices({
    ownDeviceId: deviceId,
    onChange: next => {
      devices = next as Record<string, Device<Info>>;
      for (const listener of listeners) listener(devices);
    },
    onError: failed,
    onReady: () => options.onError?.(undefined),
  });

  // answering: a peer connection for each offer, its channels handed to accept
  const { accept } = options;
  const listening = accept && provider.answerOffers(deviceId, async offer => {
    if (!running) return undefined;
    const peer = track(webrtc.createPeer(self.iceServers));
    peer.onChannel(channel => {
      const raw = fromDataChannel(channel);
      const holding = held(raw);
      let taken: boolean | void = false;
      try {
        taken = accept({ ...channelOf(channel.label, holding.pipe), from: offer.from });
      } catch (error) {
        console.error(`rtc-sdk: accepting ${channel.label} from ${offer.from} failed:`, error);
      }
      // refused, it's left to the other side to close
      if (taken === false) return raw.send(REFUSED);
      raw.send(ACCEPTED);
      holding.release();
    });
    // settled once it's up or it's failed - its messages can go then
    const settled = new Promise<void>(resolve => {
      const timer = setTimeout(() => peer.close(), ANSWERED_TIMEOUT_MS);
      peer.onState(state => {
        if (state !== 'connected' && state !== 'failed' && state !== 'closed') return;
        clearTimeout(timer);
        resolve();
      });
    });
    try {
      const sdp = await peer.answer(offer.sdp);
      return { answer: { version: 2, sessionId: offer.sessionId, sdp }, settled };
    } catch (error) {
      peer.close();
      throw error;
    }
  }, failed);

  async function connect(target: string, connectOptions: ConnectOptions = {}): Promise<RtcLink> {
    const { answerTimeoutMs = 60_000, connectTimeoutMs = 20_000 } = connectOptions;
    if (!running) throw new Error('this host has stopped');
    // the other device's own servers, if it's said
    const iceServers = devices[target]?.iceServers?.length ? devices[target].iceServers : self.iceServers;
    const peer = track(webrtc.createPeer(iceServers));
    try {
      const sdp = await peer.offer();
      const answer = await provider.sendOffer(target, {
        version: 2, sessionId: crypto.randomUUID(), from: deviceId, createdAt: new Date().toISOString(), sdp,
      }, answerTimeoutMs);
      await peer.accept(answer.sdp);
      await connected(peer, connectTimeoutMs);
    } catch (error) {
      peer.close();
      throw error;
    }
    return {
      deviceId: target,
      async open(label) {
        const channel = await peer.openChannel(label);
        const { accepted, pipe } = verdict(fromDataChannel(channel));
        if (!await accepted) {
          channel.close();
          throw new Error(`${target} refused ${label}`);
        }
        return channelOf(label, pipe);
      },
      onClose(listener) {
        let ended = false;
        const end = (state: RtcState) => {
          if (ended || (state !== 'disconnected' && state !== 'failed' && state !== 'closed')) return;
          ended = true;
          listener();
        };
        peer.onState(end);
        end(peer.state);
      },
      close: () => peer.close(),
    };
  }

  async function stop({ offline = true }: { offline?: boolean } = {}) {
    if (!running) return;
    running = false;
    clearInterval(heartbeat);
    watch.stop();
    listening?.stop();
    for (const peer of peers) peer.close();
    peers.clear();
    devices = {};
    for (const listener of listeners) listener(devices);
    if (offline && publishes) await publish(false).catch(() => { });
  }

  return {
    deviceId,
    get devices() { return devices; },
    onDevices(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    connect,
    update(changes) {
      if (!running) return;
      const beatChanged = changes.heartbeatSeconds !== undefined && changes.heartbeatSeconds !== self.heartbeatSeconds;
      Object.assign(self, Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined)));
      if (!publishes) return;
      if (beatChanged) beat();
      publish().catch(failed);
    },
    stop,
  };
}

// a peer connection coming up, or not in time
function connected(peer: RtcPeer, timeoutMs: number) {
  return new Promise<void>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => finish(new Error('the connection didn\'t come up - the networks between may need a TURN server')), timeoutMs);
    function finish(error?: Error) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    }
    const check = (state: RtcState) => {
      if (state === 'connected') finish();
      else if (state === 'failed' || state === 'closed') finish(new Error('the connection failed'));
    };
    peer.onState(check);
    check(peer.state);
  });
}
