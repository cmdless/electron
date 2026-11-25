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
export function folderFiles(root: string): SignalFiles {
  const at = (relative: string) => path.join(root, ...relative.split('/').filter(Boolean));
  let writes = 0;

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
      let watcher: FSWatcher | undefined;
      let retry: NodeJS.Timeout | undefined;
      // changes are handled one batch at a time, in order
      let handling: Promise<void> = Promise.resolve();

      const failed = (error: unknown) => {
        if (!running) return;
        watcher?.close();
        watcher = undefined;
        if (onError(error) === 'stop') return stop();
        retry = setTimeout(() => void start(), RETRY_MS);
      };
      const handle = (work: () => Promise<void>) => {
        handling = handling.then(async () => { if (running) await work(); }).catch(failed);
      };

      async function start() {
        try {
          await fs.mkdir(directory, { recursive: true });
          // watched before it's listed, so nothing written in between is missed
          watcher = watchFolder(directory, (_, name) => {
            if (!name || isTemporary(name)) return;
            handle(async () => {
              const removed = await fs.access(path.join(directory, name)).then(() => false, () => true);
              await onChanges([{ name, removed }], false);
            });
          });
          watcher.on('error', failed);
          const names = (await fs.readdir(directory)).filter(name => !isTemporary(name));
          handle(() => onChanges(names.map(name => ({ name, removed: false })), true));
        } catch (error) {
          failed(error);
        }
      }

      function stop() {
        running = false;
        clearTimeout(retry);
        watcher?.close();
        watcher = undefined;
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
