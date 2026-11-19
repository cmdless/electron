import fs from 'node:fs';
import path from 'node:path';

// where a folder's log is
export const logFile = (folder: string) => path.join(folder, 'log.txt');

// appends timestamped lines to log.txt in a folder - there from the start,
// so it can be watched. It never throws: a log that can't be written isn't
// worth stopping for.
export function createLog(folder: string) {
  const file = logFile(folder);
  try {
    fs.closeSync(fs.openSync(file, 'a'));
  } catch { /* written to as it can be */ }
  return (message: string) => {
    fs.appendFile(file, `${new Date().toISOString()} ${message}\n`, () => { });
  };
}
