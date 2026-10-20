import { advertisementPath, createDropbox, DEVICES_FOLDER, DropboxError, isOnline } from '@cmdless/peerlink-sdk';
import type { Advertisement, Device, DropboxEntry, Offer, SettingsState } from '@cmdless/peerlink-sdk';

export const DEFAULT_HEARTBEAT_SECONDS = 60;

// how long a failed sync waits before it tries again
const RETRY_MS = 10_000;

type SyncOptions = {
  getToken: (retry: boolean) => Promise<string>;
  settings: () => SettingsState;
  offers: () => Record<string, Offer>;
  setDevices: (edit: (devices: Record<string, Device>) => void) => void;
  // a failure the sync can't get past by itself (no token, a refused one)
  onStopped: (reason: string) => void;
  onError: (reason: string | undefined) => void;
};

const heartbeatOf = (settings: SettingsState) => settings.heartbeatSeconds ?? DEFAULT_HEARTBEAT_SECONDS;

// keeps this device's advertisement written, and every other device's read,
// for as long as it runs: writes on change and on every heartbeat, and
// watches /devices with longpoll
export function createSync(options: SyncOptions) {
  const dropbox = createDropbox(options.getToken);
  const seen = new Map<string, Advertisement>();
  let running = false;
  let poll: AbortController | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let onlineCheck: NodeJS.Timeout | undefined;
  let publishing: Promise<void> = Promise.resolve();

  const advertisement = (online: boolean): Advertisement => {
    const settings = options.settings();
    return {
      version: 1,
      deviceId: settings.deviceId,
      name: settings.deviceName,
      updatedAt: new Date().toISOString(),
      heartbeatSeconds: heartbeatOf(settings),
      online,
      offers: Object.fromEntries(Object.values(options.offers()).map(({ id, kind, name }) => [id, { id, kind, name }])),
    };
  };

  // one write at a time, always of the state as it is when it runs
  function publish(online = true) {
    publishing = publishing.catch(() => { }).then(async () => {
      const own = advertisement(online);
      await dropbox.upload(advertisementPath(own.deviceId), JSON.stringify(own, null, 2));
    });
    return publishing;
  }

  const toDevice = (advertisement: Advertisement): Device => ({
    name: advertisement.name,
    updatedAt: advertisement.updatedAt,
    online: isOnline(advertisement),
    offers: advertisement.offers,
  });

  async function apply(entries: DropboxEntry[]) {
    const ownPath = advertisementPath(options.settings().deviceId).toLowerCase();
    for (const entry of entries) {
      if (entry.path_lower === ownPath || !entry.path_lower.endsWith('.json')) continue;
      const deviceId = entry.name.replace(/\.json$/i, '');
      if (entry['.tag'] === 'deleted') {
        seen.delete(deviceId);
        options.setDevices(devices => { delete devices[deviceId]; });
      } else if (entry['.tag'] === 'file') {
        try {
          const advertisement = JSON.parse(await dropbox.download(entry.path_lower)) as Advertisement;
          seen.set(deviceId, advertisement);
          options.setDevices(devices => { devices[deviceId] = toDevice(advertisement); });
        } catch (error) {
          // one unreadable file doesn't stop the rest
          console.error(`peerlink: couldn't read ${entry.path_lower}:`, error);
        }
      }
    }
  }

  // a device that stops writing goes quiet rather than offline, so its
  // heartbeat age is checked on a timer
  function checkOnline() {
    options.setDevices(devices => {
      for (const [deviceId, advertisement] of seen)
        if (devices[deviceId]) devices[deviceId].online = isOnline(advertisement);
    });
  }

  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  async function watch() {
    while (running) {
      try {
        // writing first means the folder exists to list
        await publish();
        let { entries, cursor } = await dropbox.listFolder(DEVICES_FOLDER);
        await apply(entries);
        options.onError(undefined);

        while (running) {
          poll = new AbortController();
          const { changes, backoff } = await dropbox.longpoll(cursor, 60, poll.signal);
          if (changes) {
            ({ entries, cursor } = await dropbox.listFolderContinue(cursor));
            await apply(entries);
          }
          if (backoff) await wait(backoff * 1000);
        }
      } catch (error) {
        if (!running) return;
        // a refused token won't fix itself by waiting
        if (error instanceof DropboxError && error.status === 401) {
          stop(false);
          options.onStopped('Dropbox refused the sign-in');
          return;
        }
        if ((error as Error).message?.startsWith('not signed in')) {
          stop(false);
          options.onStopped((error as Error).message);
          return;
        }
        options.onError(String((error as Error).message ?? error));
        await wait(RETRY_MS);
      }
    }
  }

  function stop(markOffline: boolean) {
    if (!running) return Promise.resolve();
    running = false;
    poll?.abort();
    clearInterval(heartbeat);
    clearInterval(onlineCheck);
    seen.clear();
    options.setDevices(devices => { for (const id of Object.keys(devices)) delete devices[id]; });
    return markOffline ? publish(false).catch(() => { }) : Promise.resolve();
  }

  return {
    get running() { return running; },
    start() {
      if (running) return;
      running = true;
      const every = heartbeatOf(options.settings()) * 1000;
      heartbeat = setInterval(() => publish().catch(error => options.onError(String(error.message ?? error))), every);
      onlineCheck = setInterval(checkOnline, Math.min(every, 15_000));
      void watch();
    },
    stop,
    // something in the advertisement changed - write it now
    changed() {
      if (running) publish().catch(error => options.onError(String(error.message ?? error)));
    },
  };
}
