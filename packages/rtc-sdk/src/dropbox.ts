// a small Dropbox API client - just what peerlink needs, on fetch, so the
// daemon and a browser page use the same one

import { fileSignaling } from './providers.js';
import type { FileChange, SignalFiles, SignalingProvider } from './providers.js';

// cmdless's own Dropbox app (peerlink's) - its key is public, as PKCE allows
export const DROPBOX_APP_KEY = '6bvilhwtvusnqaa';

// where cmdless's own app sends a sign-in back
export const DROPBOX_REDIRECT_URI = 'http://localhost/cmdless-auth';

// a Dropbox app to sign in to: peerlink's own, or one of yours - its app key,
// and one of the redirect URIs registered for it. Nothing has to answer at
// that URI: the sign-in window catches the redirect before it's requested.
// Everything goes in the app's own App folder, so only devices signed in to
// the same Dropbox account through the same app see each other.
export const dropboxApp = (appKey = DROPBOX_APP_KEY, redirectUri = DROPBOX_REDIRECT_URI) => ({
  id: 'dropbox',
  authorizeUrl: 'https://www.dropbox.com/oauth2/authorize',
  tokenUrl: 'https://api.dropboxapi.com/oauth2/token',
  clientId: appKey,
  redirectUri,
  extraParams: { token_access_type: 'offline' },
});

export type DropboxEntry =
  | { '.tag': 'file'; name: string; path_lower: string; rev: string; server_modified: string }
  | { '.tag': 'folder'; name: string; path_lower: string }
  | { '.tag': 'deleted'; name: string; path_lower: string };

type ListFolderResult = { entries: DropboxEntry[]; cursor: string; has_more: boolean };

export class DropboxError extends Error {
  constructor(readonly status: number, readonly summary: string) {
    super(`Dropbox ${status}: ${summary}`);
  }
}

// getToken is asked for a token before every call, and again (with
// retry: true) when Dropbox refuses one - so whoever holds the token can
// refresh it
export function createDropbox(getToken: (retry: boolean) => Promise<string>) {
  async function call(url: string, init: (token: string) => RequestInit): Promise<Response> {
    for (const retry of [false, true]) {
      const response = await fetch(url, init(await getToken(retry)));
      if (response.status === 401 && !retry) continue;
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        let summary = text;
        try { summary = JSON.parse(text).error_summary ?? text; } catch { }
        throw new DropboxError(response.status, summary || response.statusText);
      }
      return response;
    }
    throw new Error('unreachable');
  }

  const rpc = async <T>(endpoint: string, body: unknown): Promise<T> => {
    const response = await call(`https://api.dropboxapi.com/2/${endpoint}`, token => ({
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }));
    return response.json() as Promise<T>;
  };

  // Dropbox-API-Arg is a header, so anything outside ASCII is escaped
  const apiArg = (value: unknown) =>
    JSON.stringify(value).replace(/[\u007f-￿]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);

  return {
    async upload(path: string, contents: string) {
      await call('https://content.dropboxapi.com/2/files/upload', token => ({
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/octet-stream',
          // mute: an update every heartbeat shouldn't notify anyone
          'dropbox-api-arg': apiArg({ path, mode: 'overwrite', mute: true }),
        },
        body: contents,
      }));
    },

    async remove(path: string) {
      await rpc('files/delete_v2', { path });
    },

    async download(path: string) {
      const response = await call('https://content.dropboxapi.com/2/files/download', token => ({
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'dropbox-api-arg': apiArg({ path }) },
      }));
      return response.text();
    },

    // every entry in a folder (following has_more), and the cursor to watch it from
    async listFolder(path: string) {
      let page = await rpc<ListFolderResult>('files/list_folder', { path });
      const entries = [...page.entries];
      while (page.has_more) {
        page = await rpc<ListFolderResult>('files/list_folder/continue', { cursor: page.cursor });
        entries.push(...page.entries);
      }
      return { entries, cursor: page.cursor };
    },

    // what changed since cursor, and the cursor to continue from
    async listFolderContinue(cursor: string) {
      let page = await rpc<ListFolderResult>('files/list_folder/continue', { cursor });
      const entries = [...page.entries];
      while (page.has_more) {
        page = await rpc<ListFolderResult>('files/list_folder/continue', { cursor: page.cursor });
        entries.push(...page.entries);
      }
      return { entries, cursor: page.cursor };
    },

    // waits (up to timeout seconds) until something changes since cursor.
    // It takes no token - the cursor alone says what to watch.
    async longpoll(cursor: string, timeout = 60, signal?: AbortSignal) {
      const response = await fetch('https://notify.dropboxapi.com/2/files/list_folder/longpoll', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cursor, timeout }),
        signal,
      });
      if (!response.ok) throw new DropboxError(response.status, await response.text().catch(() => response.statusText));
      return response.json() as Promise<{ changes: boolean; backoff?: number }>;
    },
  };
}

export type Dropbox = ReturnType<typeof createDropbox>;

// how long a watch that failed waits before it tries again - and how long
// one waits for a folder nobody's written to yet
const RETRY_MS = 10_000;
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const notFound = (error: unknown) => error instanceof DropboxError && error.status === 409 && error.summary.includes('not_found');

// a Dropbox app folder as files: a folder is watched by listing it, then
// longpolling for changes and listing only what changed
export function dropboxFiles(dropbox: Dropbox): SignalFiles {
  const changesOf = (entries: DropboxEntry[]): FileChange[] => entries
    .filter(entry => entry['.tag'] !== 'folder')
    .map(entry => ({ name: entry.name, removed: entry['.tag'] === 'deleted' }));

  return {
    write: (path, text) => dropbox.upload(path, text),
    read: path => dropbox.download(path),
    remove: path => dropbox.remove(path),
    watch(folder, onChanges, onError) {
      let running = true;
      let poll: AbortController | undefined;
      void (async () => {
        while (running) {
          try {
            let listed;
            try {
              listed = await dropbox.listFolder(folder);
            } catch (error) {
              if (!notFound(error)) throw error;
              // nothing's been written there yet
              await onChanges([], true);
              await wait(RETRY_MS);
              continue;
            }
            let { cursor } = listed;
            if (running) await onChanges(changesOf(listed.entries), true);
            while (running) {
              poll = new AbortController();
              const { changes, backoff } = await dropbox.longpoll(cursor, 60, poll.signal);
              if (changes) {
                const next = await dropbox.listFolderContinue(cursor);
                cursor = next.cursor;
                if (running) await onChanges(changesOf(next.entries), false);
              }
              if (backoff) await wait(backoff * 1000);
            }
          } catch (error) {
            if (!running) return;
            if (onError(error) === 'stop') return void (running = false);
            await wait(RETRY_MS);
          }
        }
      })();
      return {
        stop() {
          running = false;
          poll?.abort();
        },
      };
    },
  };
}

// signaling through a Dropbox app folder. getToken is the Dropbox client's
// (see createDropbox); a refused or missing token needs a sign-in - and so
// does anything else signedOut says does (whatever getToken throws for it).
export function dropboxSignaling(getToken: (retry: boolean) => Promise<string>, signedOut?: (error: unknown) => boolean): SignalingProvider {
  return fileSignaling(dropboxFiles(createDropbox(getToken)), error =>
    (error instanceof DropboxError && error.status === 401)
    || String((error as Error)?.message ?? error).includes('not signed in')
    || !!signedOut?.(error));
}
