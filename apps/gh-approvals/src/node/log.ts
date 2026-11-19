import fs from 'node:fs';
import path from 'node:path';

// appends timestamped lines to log.txt in a folder. It never throws: a log
// that can't be written isn't worth stopping for.
export function createLog(folder: string) {
  const file = path.join(folder, 'log.txt');
  return (message: string) => {
    fs.appendFile(file, `${new Date().toISOString()} ${message}\n`, () => { });
  };
}
