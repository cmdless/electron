import fs from 'node:fs';
import path from 'node:path';

// a provider's tokens as kept on disk - never sent anywhere but its owner
export type StoredToken = {
  key: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
};

// one file per provider key, in a folder only this user can open
export function createTokenFiles(dir: string) {
  const fileOf = (key: string) => path.join(dir, `${key.replace(/[^A-Za-z0-9._-]/g, '-')}.json`);

  return {
    read(key: string): StoredToken | undefined {
      try {
        return JSON.parse(fs.readFileSync(fileOf(key), 'utf8')) as StoredToken;
      } catch {
        return undefined;
      }
    },
    write(token: StoredToken) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = fileOf(token.key);
      const temp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(token, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(temp, file);
    },
    remove(key: string) {
      fs.rmSync(fileOf(key), { force: true });
    },
    // every stored token, for the statuses the broker starts with
    all(): StoredToken[] {
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir)
        .filter(name => name.endsWith('.json'))
        .flatMap(name => {
          try { return [JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as StoredToken]; }
          catch { return []; }
        });
    },
  };
}
