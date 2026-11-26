import { advertisementPath, answerPath, DEVICES_FOLDER, isOnline, offerPath, signalFolder, SIGNAL_TTL_MS } from './signaling.js';
import type { Advertisement, Device, SignalAnswer, SignalOffer } from './signaling.js';

// what keeps devices in touch: each one's advertisement, and the WebRTC
// offers and answers between them. How it's carried - in memory, a shared
// folder, Dropbox, anything else - is the provider's business: it watches
// however it can, and nobody above it sees a file. Devices see each other
// when their hosts use the same one.
export type SignalingProvider = {
  // this device's advertisement, written for the others (again, each time)
  publish(advertisement: Advertisement): Promise<void>;
  // every other device's advertisement, kept up with
  watchDevices(options: DeviceWatchOptions): Watch;
  // the offers other devices send this one, each answered by handle
  answerOffers(deviceId: string, handle: OfferHandler, onError: ErrorHandler): Watch;
  // an offer to a device, and its answer once it gives one
  sendOffer(deviceId: string, offer: SignalOffer, timeoutMs: number): Promise<SignalAnswer>;
  // a failure only the person can get past (a sign-in), not one to wait out
  needsPerson(error: unknown): boolean;
};

export type Watch = { stop(): void };

// a failure: 'stop' ends what failed, 'retry' tries again shortly
export type ErrorHandler = (error: unknown) => 'stop' | 'retry';

export type DeviceWatchOptions = {
  // left out of what's reported - a host doesn't list itself
  ownDeviceId?: string;
  onChange: (devices: Record<string, Device>) => void;
  onError?: ErrorHandler;
  // called once the watch is caught up after a start or a failure
  onReady?: () => void;
};

// answers one offer, or turns it down (undefined): the answer, and when the
// connection it starts has settled, either way - its messages can go then
export type OfferHandler = (offer: SignalOffer) => Promise<{ answer: SignalAnswer; settled: Promise<unknown> } | undefined>;

// Files a provider keeps - what the providers that carry everything as files
// are built on. Paths are /-separated from the provider's root.
export type FileChange = { name: string; removed: boolean };
export type SignalFiles = {
  write(path: string, text: string): Promise<void>;
  read(path: string): Promise<string>;
  remove(path: string): Promise<void>;
  // the files in a folder now (none if it isn't there yet), with initial
  // true, then each change after - until stopped
  watch(folder: string, onChanges: (changes: FileChange[], initial: boolean) => Promise<void>, onError: ErrorHandler): Watch;
};

const toDevice = (advertisement: Advertisement): Device => ({
  name: advertisement.name,
  updatedAt: advertisement.updatedAt,
  online: isOnline(advertisement),
  iceServers: advertisement.iceServers ?? [],
  info: advertisement.info,
});

// the most often any device writes, so a missed heartbeat shows up in time
const ONLINE_CHECK_MS = 15_000;

// a provider that carries everything as files, laid out as signaling.ts says
export function fileSignaling(files: SignalFiles, needsPerson: (error: unknown) => boolean): SignalingProvider {
  return {
    needsPerson,

    async publish(advertisement) {
      await files.write(advertisementPath(advertisement.deviceId), JSON.stringify(advertisement, null, 2));
    },

    // A device that stops writing goes quiet rather than offline, so
    // heartbeat ages are re-checked on a timer too.
    watchDevices({ ownDeviceId, onChange, onError, onReady }) {
      const advertisements = new Map<string, Advertisement>();
      const report = () => onChange(Object.fromEntries(
        [...advertisements].map(([deviceId, advertisement]) => [deviceId, toDevice(advertisement)])));
      const watch = files.watch(DEVICES_FOLDER, async (changes, initial) => {
        if (initial) advertisements.clear();
        for (const { name, removed } of changes) {
          if (!name.endsWith('.json')) continue;
          const deviceId = name.slice(0, -'.json'.length);
          if (deviceId === ownDeviceId) continue;
          if (removed) {
            advertisements.delete(deviceId);
            continue;
          }
          try {
            const advertisement = JSON.parse(await files.read(`${DEVICES_FOLDER}/${name}`)) as Advertisement;
            // one written by a version that doesn't speak this one
            if (advertisement.version !== 2) continue;
            advertisements.set(deviceId, advertisement);
          } catch (error) {
            // one unreadable file doesn't stop the rest
            console.error(`peerlink: couldn't read ${name}:`, error);
          }
        }
        report();
        if (initial) onReady?.();
      }, error => onError?.(error) ?? 'retry');
      const onlineCheck = setInterval(() => { if (advertisements.size) report(); }, ONLINE_CHECK_MS);
      return {
        stop() {
          watch.stop();
          clearInterval(onlineCheck);
        },
      };
    },

    answerOffers(deviceId, handle, onError) {
      const answered = new Set<string>();
      const cleanUp = (sessionId: string) => Promise.allSettled([
        files.remove(offerPath(deviceId, sessionId)),
        files.remove(answerPath(deviceId, sessionId)),
      ]);
      async function answer(sessionId: string) {
        const offer = JSON.parse(await files.read(offerPath(deviceId, sessionId))) as SignalOffer;
        if (Date.now() - Date.parse(offer.createdAt) > SIGNAL_TTL_MS) return void await cleanUp(sessionId);
        const handled = await handle(offer);
        if (!handled) return void await cleanUp(sessionId);
        await files.write(answerPath(deviceId, sessionId), JSON.stringify(handled.answer));
        void handled.settled.finally(() => cleanUp(sessionId));
      }
      return files.watch(signalFolder(deviceId), async changes => {
        for (const { name, removed } of changes) {
          const sessionId = /^(.+)\.offer\.json$/.exec(name)?.[1];
          if (!sessionId || removed || answered.has(sessionId)) continue;
          answered.add(sessionId);
          answer(sessionId).catch(error => console.error(`peerlink: couldn't answer ${sessionId}:`, error));
        }
      }, onError);
    },

    // the offer's written first, so the folder's there to watch - and an
    // answer can't come before it, so watching after misses nothing
    async sendOffer(deviceId, offer, timeoutMs) {
      await files.write(offerPath(deviceId, offer.sessionId), JSON.stringify(offer));
      const wanted = `${offer.sessionId}.answer.json`;
      return new Promise<SignalAnswer>((resolve, reject) => {
        let done = false;
        const finish = (settle: () => void) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          watch.stop();
          settle();
        };
        const timer = setTimeout(() => finish(() => reject(new Error('timed out waiting for the other device to answer'))), timeoutMs);
        const watch = files.watch(signalFolder(deviceId), async changes => {
          if (done || !changes.some(change => change.name === wanted && !change.removed)) return;
          const answer = JSON.parse(await files.read(answerPath(deviceId, offer.sessionId))) as SignalAnswer;
          finish(() => resolve(answer));
        }, error => {
          finish(() => reject(error as Error));
          return 'stop';
        });
      });
    },
  };
}
