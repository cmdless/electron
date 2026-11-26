import fs from 'node:fs/promises';
import { watch as watchFolder } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import path from 'node:path';
import { fileSignaling } from '../providers.js';
import type { SignalFiles, SignalingProvider } from '../providers.js';

// how long a watch that failed waits before it tries again
const RETRY_MS = 10_000;

// half-written files, never reported
const isTemporary = (name: string) => name.endsWith('.tmp');

// a folder on disk as files - written beside and renamed into place, so
// nobody ever reads half of one, and watched by the OS's own file events.
// Whatever keeps it in step across machines (OneDrive, Dropbox, a sync
// client) only has to deliver the files: a network share that sends no file
// events won't be noticed changing.
//
// The whole folder is watched once, recursively, and each event handed to
// whoever's watching where it happened: on macOS every watch in a process
// shares one event stream, rebuilt whenever a watch comes or goes, and
// anything that happens while it's rebuilt is lost.
export function folderFiles(root: string): SignalFiles {
  const at = (relative: string) => path.join(root, ...relative.split('/').filter(Boolean));
  let writes = 0;

  // the one watcher, and who's listening where (by folder, as '/a/b')
  type Listener = { changed: (name: string) => void; failed: (error: unknown) => void };
  const listening = new Map<string, Set<Listener>>();
  let watcher: FSWatcher | undefined;
  const listen = async (folder: string, listener: Listener) => {
    await fs.mkdir(at(folder), { recursive: true });
    if (!watcher) {
      const started = watchFolder(root, { recursive: true }, (_, filename) => {
        if (!filename) return;
        const parts = filename.split(path.sep);
        const name = parts.pop()!;
        for (const each of listening.get(`/${parts.join('/')}`) ?? []) each.changed(name);
      });
      started.on('error', error => {
        if (watcher === started) watcher = undefined;
        started.close();
        for (const set of listening.values()) for (const each of [...set]) each.failed(error);
      });
      watcher = started;
    }
    const key = `/${folder.split('/').filter(Boolean).join('/')}`;
    listening.set(key, (listening.get(key) ?? new Set()).add(listener));
    return () => {
      const set = listening.get(key);
      set?.delete(listener);
      if (set?.size === 0) listening.delete(key);
      if (listening.size === 0) {
        watcher?.close();
        watcher = undefined;
      }
    };
  };

  return {
    async write(relative, text) {
      const file = at(relative);
      await fs.mkdir(path.dirname(file), { recursive: true });
      const temporary = `${file}.${process.pid}.${++writes}.tmp`;
      await fs.writeFile(temporary, text);
      await fs.rename(temporary, file);
    },
    read: relative => fs.readFile(at(relative), 'utf8'),
    async remove(relative) {
      await fs.rm(at(relative), { force: true });
    },
    watch(folder, onChanges, onError) {
      const directory = at(folder);
      let running = true;
      let unlisten: (() => void) | undefined;
      let retry: NodeJS.Timeout | undefined;
      // changes are handled one batch at a time, in order
      let handling: Promise<void> = Promise.resolve();

      const failed = (error: unknown) => {
        if (!running) return;
        unlisten?.();
        unlisten = undefined;
        if (onError(error) === 'stop') return stop();
        retry = setTimeout(() => void start(), RETRY_MS);
      };
      const handle = (work: () => Promise<void>) => {
        handling = handling.then(async () => { if (running) await work(); }).catch(failed);
      };

      async function start() {
        try {
          // listened to before it's listed, so nothing written in between is missed
          unlisten = await listen(folder, {
            changed: name => {
              if (isTemporary(name)) return;
              handle(async () => {
                const removed = await fs.access(path.join(directory, name)).then(() => false, () => true);
                await onChanges([{ name, removed }], false);
              });
            },
            failed,
          });
          if (!running) return unlisten();
          const names = (await fs.readdir(directory)).filter(name => !isTemporary(name));
          handle(() => onChanges(names.map(name => ({ name, removed: false })), true));
        } catch (error) {
          failed(error);
        }
      }

      function stop() {
        running = false;
        clearTimeout(retry);
        unlisten?.();
        unlisten = undefined;
      }

      void start();
      return { stop };
    },
  };
}

// signaling through a folder every device can write to. There's no account:
// whoever can write the folder is in the group.
export function folderSignaling(root: string): SignalingProvider {
  return fileSignaling(folderFiles(root), () => false);
}
