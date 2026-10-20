import { DropboxError } from './dropbox.js';
import type { Dropbox, DropboxEntry } from './dropbox.js';
import { DEVICES_FOLDER, isOnline } from './index.js';
import type { Advertisement, Device } from './index.js';

// how long a failed watch waits before it tries again
const RETRY_MS = 10_000;

export type DeviceWatchOptions = {
  // left out of what's reported - a daemon doesn't list itself
  ownDeviceId?: string;
  onChange: (devices: Record<string, Device>) => void;
  // a failure: 'stop' ends the watch, 'retry' tries again shortly
  onError?: (error: unknown) => 'stop' | 'retry';
  // called once the watch is caught up after a start or a failure
  onReady?: () => void;
};

const toDevice = (advertisement: Advertisement): Device => ({
  name: advertisement.name,
  updatedAt: advertisement.updatedAt,
  online: isOnline(advertisement),
  offers: advertisement.offers,
});

// keeps up with every device's advertisement under /devices: lists them
// once, then waits on longpoll for changes and downloads only what changed.
// A device that stops writing goes quiet rather than offline, so heartbeat
// ages are re-checked on a timer too.
export function watchDevices(dropbox: Dropbox, options: DeviceWatchOptions) {
  const advertisements = new Map<string, Advertisement>();
  let running = true;
  let poll: AbortController | undefined;

  const report = () => options.onChange(Object.fromEntries(
    [...advertisements].map(([deviceId, advertisement]) => [deviceId, toDevice(advertisement)])));

  async function apply(entries: DropboxEntry[]) {
    for (const entry of entries) {
      if (!entry.path_lower.endsWith('.json')) continue;
      const deviceId = entry.name.replace(/\.json$/i, '');
      if (deviceId === options.ownDeviceId) continue;
      if (entry['.tag'] === 'deleted') advertisements.delete(deviceId);
      else if (entry['.tag'] === 'file') {
        try {
          advertisements.set(deviceId, JSON.parse(await dropbox.download(entry.path_lower)) as Advertisement);
        } catch (error) {
          // one unreadable file doesn't stop the rest
          console.error(`peerlink: couldn't read ${entry.path_lower}:`, error);
        }
      }
    }
    report();
  }

  // the most often any device writes, so a missed heartbeat shows up in time
  const onlineCheck = setInterval(() => { if (advertisements.size) report(); }, 15_000);
  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  void (async () => {
    while (running) {
      try {
        let listed;
        try {
          listed = await dropbox.listFolder(DEVICES_FOLDER);
        } catch (error) {
          // no device has written anything yet
          if (error instanceof DropboxError && error.status === 409 && error.summary.includes('not_found')) {
            listed = undefined;
          } else throw error;
        }
        if (!listed) {
          report();
          options.onReady?.();
          await wait(RETRY_MS);
          continue;
        }

        let { cursor } = listed;
        advertisements.clear();
        await apply(listed.entries);
        options.onReady?.();

        while (running) {
          poll = new AbortController();
          const { changes, backoff } = await dropbox.longpoll(cursor, 60, poll.signal);
          if (changes) {
            const next = await dropbox.listFolderContinue(cursor);
            cursor = next.cursor;
            await apply(next.entries);
          }
          if (backoff) await wait(backoff * 1000);
        }
      } catch (error) {
        if (!running) return;
        if ((options.onError?.(error) ?? 'retry') === 'stop') { stop(); return; }
        await wait(RETRY_MS);
      }
    }
  })();

  function stop() {
    running = false;
    poll?.abort();
    clearInterval(onlineCheck);
  }

  return { stop };
}
