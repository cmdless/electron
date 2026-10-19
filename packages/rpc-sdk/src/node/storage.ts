import fs from 'node:fs/promises';
import path from 'node:path';
import type { ChannelStorage } from '../state.js';

export type FileStorageOptions<T> = {
  // the state when the file doesn't exist yet - it's written out, so there's
  // a file to find and edit
  default: T;
};

// a channel kept in a JSON file: read once when the store starts, and
// rewritten whole after every change. A file that exists but isn't valid
// JSON fails the load, rather than being replaced by the default.
export function file<T>(filePath: string, options: FileStorageOptions<T>): ChannelStorage<T> {
  const write = async (state: T) => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    // written beside it and renamed over it, so a crash mid-write never
    // leaves a half-written file behind
    const temp = `${filePath}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify(state, null, 2) + '\n');
    await fs.rename(temp, filePath);
  };

  return {
    async load() {
      let text: string;
      try {
        text = await fs.readFile(filePath, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await write(options.default);
        return structuredClone(options.default);
      }
      try {
        return JSON.parse(text) as T;
      } catch (error) {
        throw new Error(`${filePath} isn't valid JSON: ${(error as Error).message}`);
      }
    },
    save: ({ state }) => write(state),
  };
}
