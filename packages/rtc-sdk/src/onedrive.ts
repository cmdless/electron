// a small Microsoft Graph client for OneDrive and SharePoint files - just
// what signaling needs, on fetch, so node and a browser page use the same one

import { fileSignaling } from './providers.js';
import type { FileChange, SignalFiles, SignalingProvider } from './providers.js';

// the App folder: this app's own folder in the signed-in user's OneDrive -
// so only that user's devices see each other through it
export const ONEDRIVE_APP_FOLDER = '/me/drive/special/approot';

// where a sign-in is sent back to: a Mobile and desktop redirect, which
// Microsoft lets any localhost URL be. Nothing has to answer there - the
// sign-in window catches the redirect before it's requested.
export const ONEDRIVE_REDIRECT_URI = 'http://localhost';

const GRAPH = 'https://graph.microsoft.com/v1.0';

// Where signaling goes, as a Graph path: the App folder (the default), or a
// folder anyone given access to it can reach - one in a SharePoint site's
// library (/sites/{siteId}/drive/root:/{folder}) or in any drive by its id
// (/drives/{driveId}/root:/{folder}). Split into the item it starts from and
// the folder under it.
export function oneDriveBase(base = ONEDRIVE_APP_FOLDER) {
  const trimmed = base.trim().replace(/:$/, '').replace(/\/$/, '');
  if (!trimmed.startsWith('/')) throw new Error(`a OneDrive base is a Graph path, like ${ONEDRIVE_APP_FOLDER} or /sites/{siteId}/drive/root:/{folder}`);
  const split = trimmed.indexOf(':/');
  const root = split < 0 ? trimmed : trimmed.slice(0, split);
  const folder = split < 0 ? '' : trimmed.slice(split + 2).replace(/^\/+/, '');
  return { root, folder, appFolder: root === ONEDRIVE_APP_FOLDER };
}

// the Entra app to sign in to: its tenant (an id, a domain, or 'common' /
// 'organizations' / 'consumers') and client id. The App folder needs only
// its own scope; anywhere else needs the user's files.
export function oneDriveApp(tenantId: string, clientId: string, base?: string, redirectUri = ONEDRIVE_REDIRECT_URI) {
  const { appFolder } = oneDriveBase(base);
  return {
    // a token for the App folder can't reach anywhere else, so the two are
    // signed in to apart
    id: appFolder ? 'onedrive-app-folder' : 'onedrive',
    authorizeUrl: `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/authorize`,
    tokenUrl: `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`,
    clientId,
    redirectUri,
    scopes: [appFolder ? 'Files.ReadWrite.AppFolder' : 'Files.ReadWrite.All', 'offline_access'],
  };
}

export class GraphError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(`Microsoft Graph ${status}: ${message || code}`);
  }
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// a path's segments escaped one by one, so its slashes stay slashes
const escapePath = (path: string) => path.split('/').filter(Boolean).map(encodeURIComponent).join('/');

// getToken is asked for a token before every call, and again (with
// retry: true) when Graph refuses one - so whoever holds the token can
// refresh it
export function createOneDrive(getToken: (retry: boolean) => Promise<string>, base?: string) {
  const { root, folder } = oneDriveBase(base);
  // an item under the base, by its path there - or the base itself
  const item = (path: string) => {
    const full = escapePath(`${folder}/${path}`);
    return full ? `${GRAPH}${root}:/${full}:` : `${GRAPH}${root}`;
  };

  async function call(url: string, init: RequestInit = {}): Promise<Response> {
    let retried = false;
    for (let attempt = 0; ; attempt++) {
      const token = await getToken(retried);
      const response = await fetch(url, { ...init, headers: { ...init.headers, authorization: `Bearer ${token}` } });
      if (response.status === 401 && !retried) {
        retried = true;
        continue;
      }
      // throttled: as long as it asks, a few times
      if ((response.status === 429 || response.status === 503) && attempt < 3) {
        await wait(Number(response.headers.get('retry-after') ?? 5) * 1000);
        continue;
      }
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        let code = '', message = text;
        try { ({ code, message } = JSON.parse(text).error); } catch { }
        throw new GraphError(response.status, code, message || response.statusText);
      }
      return response;
    }
  }

  return {
    async upload(path: string, text: string) {
      // folders on the way are made as needed
      await call(`${item(path)}/content`, { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: text });
    },

    // the content's a redirect to a download URL, which needs no token -
    // and fetch doesn't send it one
    async download(path: string) {
      return (await call(`${item(path)}/content`)).text();
    },

    async remove(path: string) {
      try {
        await call(item(path), { method: 'DELETE' });
      } catch (error) {
        if (!(error instanceof GraphError && error.status === 404)) throw error;
      }
    },

    // the files in a folder, each with its eTag - or none, if it isn't there
    async list(path: string) {
      const files = new Map<string, string>();
      let url: string | undefined = `${item(path)}/children?$select=name,eTag,file&$top=999`;
      try {
        while (url) {
          const page = await (await call(url)).json() as { value: { name: string; eTag: string; file?: object }[]; '@odata.nextLink'?: string };
          for (const entry of page.value) if (entry.file) files.set(entry.name, entry.eTag);
          url = page['@odata.nextLink'];
        }
      } catch (error) {
        if (error instanceof GraphError && error.status === 404) return files;
        throw error;
      }
      return files;
    },
  };
}

export type OneDrive = ReturnType<typeof createOneDrive>;

// how often a watched folder is listed - Graph has no long poll, and a
// webhook would need somewhere public to call
const POLL_MS = 3_000;
// how long a watch that failed waits before it tries again
const RETRY_MS = 10_000;

// a OneDrive folder as files: a folder is watched by listing it every few
// seconds, a file changed when its eTag has
export function oneDriveFiles(oneDrive: OneDrive): SignalFiles {
  return {
    write: (path, text) => oneDrive.upload(path, text),
    read: path => oneDrive.download(path),
    remove: path => oneDrive.remove(path),
    watch(folder, onChanges, onError) {
      let running = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let wake: (() => void) | undefined;
      const sleep = (ms: number) => new Promise<void>(resolve => {
        wake = resolve;
        timer = setTimeout(resolve, ms);
      });
      void (async () => {
        let known: Map<string, string> | undefined;
        while (running) {
          try {
            const listed = await oneDrive.list(folder);
            if (!running) return;
            const changes: FileChange[] = [];
            for (const [name, eTag] of listed) if (known?.get(name) !== eTag) changes.push({ name, removed: false });
            for (const name of known?.keys() ?? []) if (!listed.has(name)) changes.push({ name, removed: true });
            const initial = !known;
            known = listed;
            if (initial || changes.length) await onChanges(changes, initial);
            await sleep(POLL_MS);
          } catch (error) {
            if (!running) return;
            if (onError(error) === 'stop') return void (running = false);
            // caught up from scratch once it's back
            known = undefined;
            await sleep(RETRY_MS);
          }
        }
      })();
      return {
        stop() {
          running = false;
          clearTimeout(timer);
          wake?.();
        },
      };
    },
  };
}

// signaling through a OneDrive folder (see oneDriveBase). getToken is the
// Graph client's (see createOneDrive); a refused or missing token needs a
// sign-in - and so does anything else signedOut says does.
export function oneDriveSignaling(getToken: (retry: boolean) => Promise<string>, base?: string, signedOut?: (error: unknown) => boolean): SignalingProvider {
  return fileSignaling(oneDriveFiles(createOneDrive(getToken, base)), error =>
    (error instanceof GraphError && error.status === 401)
    || String((error as Error)?.message ?? error).includes('not signed in')
    || !!signedOut?.(error));
}
