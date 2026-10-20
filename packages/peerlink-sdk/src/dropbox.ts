// a small Dropbox API client - just what peerlink needs, on fetch, so the
// daemon and a browser page use the same one

// peerlink's Dropbox app: the client id is public with PKCE, and the
// redirect is the one registered for the auth broker
export const dropboxApp = {
  id: 'dropbox',
  authorizeUrl: 'https://www.dropbox.com/oauth2/authorize',
  tokenUrl: 'https://api.dropboxapi.com/oauth2/token',
  clientId: '6bvilhwtvusnqaa',
  redirectUri: 'http://localhost/cmdless-auth',
  extraParams: { token_access_type: 'offline' },
};

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
