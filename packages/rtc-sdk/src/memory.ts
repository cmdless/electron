import { fileSignaling } from './providers.js';
import type { FileChange, SignalFiles, SignalingProvider } from './providers.js';

// files kept in this process's memory - every watcher hears a change as it's
// made, after the change itself has settled
function memoryFiles(): SignalFiles {
  const files = new Map<string, string>();
  const watchers = new Map<string, Set<(change: FileChange) => void>>();
  const split = (path: string) => {
    const at = path.lastIndexOf('/');
    return { folder: path.slice(0, at), name: path.slice(at + 1) };
  };
  const tell = (path: string, removed: boolean) => {
    const { folder, name } = split(path);
    for (const watcher of watchers.get(folder) ?? []) queueMicrotask(() => watcher({ name, removed }));
  };

  return {
    async write(path, text) {
      files.set(path, text);
      tell(path, false);
    },
    async read(path) {
      const text = files.get(path);
      if (text === undefined) throw new Error(`no ${path}`);
      return text;
    },
    async remove(path) {
      if (files.delete(path)) tell(path, true);
    },
    watch(folder, onChanges, onError) {
      let running = true;
      // one batch at a time, in order
      let handling: Promise<void> = Promise.resolve();
      const handle = (changes: FileChange[], initial: boolean) => {
        handling = handling.then(async () => { if (running) await onChanges(changes, initial); }).catch(error => {
          if (running && onError(error) === 'stop') stop();
        });
      };
      const watcher = (change: FileChange) => handle([change], false);
      const listening = watchers.get(folder) ?? new Set();
      watchers.set(folder, listening.add(watcher));
      const existing = [...files.keys()].filter(path => split(path).folder === folder).map(path => ({ name: split(path).name, removed: false }));
      handle(existing, true);

      function stop() {
        running = false;
        listening.delete(watcher);
      }
      return { stop };
    },
  };
}

// signaling within this process - hosts that share one see each other, and
// nothing else does. For tests, and for hosts that live side by side.
export function memorySignaling(): SignalingProvider {
  return fileSignaling(memoryFiles(), () => false);
}
