import fs from 'node:fs/promises';
import path from 'node:path';

// what an error says, on one line - gh and GitHub can say a lot
export const firstLine = (error: unknown) => (error instanceof Error ? error.message : String(error)).split('\n')[0];

// Runs work one at a time. A call while it runs queues one more run after it,
// however many calls there are, with their arguments merged; each call's
// promise settles once the work it asked for has run. The work itself is
// expected not to throw - a run that does ends the queue.
export function coalesce<A>(work: (arg: A) => Promise<void>, merge: (queued: A, next: A) => A) {
  let running: Promise<void> | undefined;
  let queued: { arg: A } | undefined;
  return (arg: A): Promise<void> => {
    if (running) {
      queued = { arg: queued ? merge(queued.arg, arg) : arg };
      return running;
    }
    return running = (async () => {
      let next: { arg: A } | undefined = { arg };
      try {
        while (next) {
          queued = undefined;
          await work(next.arg);
          next = queued;
        }
      } finally {
        running = undefined;
      }
    })();
  };
}

// each write's own temporary name, so two writes of one file never share one
let writes = 0;

// a file written whole, under a name of its own and then renamed into place,
// so nobody ever reads half of one
export async function writeAtomic(file: string, text: string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${++writes}.tmp`;
  await fs.writeFile(temporary, text);
  await fs.rename(temporary, file);
}
