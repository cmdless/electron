import fs from 'node:fs';
import { memory } from '@cmdless/rpc-sdk';
import { UIHost } from '@cmdless/ui-sdk/node';
import { logProtocol } from '../shared/protocols.js';
import { page } from './page.js';
import { coalesce } from './util.js';
import type { LogState } from '../shared/protocols.js';

// how much of the end of the file is read, and how many lines of it are shown
const TAIL_BYTES = 256 * 1024;
const TAIL_LINES = 1000;

// the last lines of a file, reading only its end
async function tail(file: string) {
  const handle = await fs.promises.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - TAIL_BYTES);
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(size - start), 0, size - start, start);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
    // a read that starts mid-file starts mid-line too
    if (start > 0) lines.shift();
    if (lines.at(-1) === '') lines.pop();
    return lines.slice(-TAIL_LINES);
  } finally {
    await handle.close();
  }
}

export type LogViewerParams = { file: string; title?: string };

// a window tailing a file: its state is the file's last lines, read again
// whenever the file changes - one read at a time, with one more after it if
// it changed meanwhile - for as long as the window is open
export const logViewer = UIHost.factory(async (opener, { file, title }: LogViewerParams) => {
  const store = await logProtocol.createStore({ log: memory<LogState>({ file, lines: await tail(file).catch(() => []) }) });

  const reread = coalesce<void>(async () => {
    const lines = await tail(file).catch(() => store.state.log.lines);
    await store.set({ log: { file, lines } }).catch(() => { });
  }, () => undefined);
  const watcher = fs.watch(file, () => void reread());

  try {
    const window = await opener.openWindow({
      type: 'file', source: page('/log'), window: { title, width: 900, height: 600 },
      backend: logProtocol.accept(undefined, store),
    });
    void window.closed.finally(() => watcher.close());
    return window;
  } catch (error) {
    watcher.close();
    throw error;
  }
});
