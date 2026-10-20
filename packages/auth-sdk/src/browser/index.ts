import { providerKey } from '../index.js';
import type { AccessToken, OAuthProvider } from '../index.js';

export class NotSignedIn extends Error { }

type TokenResponse = { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };

const EXPIRY_MARGIN_MS = 60_000;

function base64url(bytes: ArrayBuffer | Uint8Array) {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const randomString = (length: number) => base64url(crypto.getRandomValues(new Uint8Array(length)));

// signing in from a web page, without the broker: PKCE with a redirect
// back to the page itself (provider.redirectUri, registered with the
// provider). The refresh token is kept in `storage` (localStorage by
// default) so the page stays signed in across visits; the access token only
// ever lives in memory.
export function createBrowserAuth(provider: OAuthProvider, storage: Storage = localStorage) {
  const key = `cmdless-auth:${providerKey(provider)}`;
  const pendingKey = `${key}:pending`;
  let access: AccessToken | undefined;

  async function requestTokens(form: Record<string, string>) {
    const response = await fetch(provider.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: provider.clientId, ...form }),
    });
    const body = await response.json().catch(() => ({})) as TokenResponse;
    if (!response.ok || !body.access_token)
      throw Object.assign(new Error(body.error_description ?? body.error ?? `${response.status} ${response.statusText}`), { refused: response.status >= 400 && response.status < 500 });
    if (body.refresh_token) storage.setItem(key, body.refresh_token);
    access = {
      accessToken: body.access_token,
      expiresAt: body.expires_in ? new Date(Date.now() + body.expires_in * 1000).toISOString() : undefined,
    };
    return access;
  }

  return {
    // whether there's a sign-in to use, without checking it still works
    get signedIn() {
      return !!access || !!storage.getItem(key);
    },

    // leaves the page for the provider's sign-in; it comes back to
    // redirectUri, where completeSignIn finishes the job
    async signIn() {
      const verifier = randomString(32);
      const state = randomString(16);
      const challenge = base64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
      // only this tab needs it, and only until it comes back
      sessionStorage.setItem(pendingKey, JSON.stringify({ verifier, state }));

      const url = new URL(provider.authorizeUrl);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', provider.clientId);
      url.searchParams.set('redirect_uri', provider.redirectUri);
      url.searchParams.set('code_challenge', challenge);
      url.searchParams.set('code_challenge_method', 'S256');
      url.searchParams.set('state', state);
      if (provider.scopes?.length) url.searchParams.set('scope', provider.scopes.join(' '));
      for (const [name, value] of Object.entries(provider.extraParams ?? {}))
        url.searchParams.set(name, value);
      window.location.assign(url.toString());
    },

    // on the page the provider sent back to: trades the code for tokens,
    // and takes it out of the address bar. Resolves false when there was no
    // sign-in to complete.
    async completeSignIn() {
      const url = new URL(window.location.href);
      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');
      const error = url.searchParams.get('error_description') ?? url.searchParams.get('error');
      if (!code && !error) return false;

      const pending = sessionStorage.getItem(pendingKey);
      sessionStorage.removeItem(pendingKey);
      for (const name of ['code', 'state', 'error', 'error_description']) url.searchParams.delete(name);
      window.history.replaceState(null, '', url.toString());

      if (error) throw new Error(`sign-in failed: ${error}`);
      if (!pending) throw new Error('sign-in failed: this tab didn\'t start it');
      const { verifier, state } = JSON.parse(pending) as { verifier: string; state: string };
      if (returnedState !== state) throw new Error('sign-in failed: the state didn\'t match');
      await requestTokens({ grant_type: 'authorization_code', code: code!, redirect_uri: provider.redirectUri, code_verifier: verifier });
      return true;
    },

    // a valid access token, refreshed when stale
    async getToken(): Promise<string> {
      if (access && (!access.expiresAt || Date.parse(access.expiresAt) - EXPIRY_MARGIN_MS > Date.now()))
        return access.accessToken;
      const refreshToken = storage.getItem(key);
      if (!refreshToken) throw new NotSignedIn(`not signed in to ${provider.id}`);
      try {
        return (await requestTokens({ grant_type: 'refresh_token', refresh_token: refreshToken })).accessToken;
      } catch (error) {
        if ((error as { refused?: boolean }).refused) {
          storage.removeItem(key);
          throw new NotSignedIn(`the stored sign-in to ${provider.id} no longer works`);
        }
        throw error;
      }
    },

    // forgets the token, so the next getToken needs a new sign-in
    expire() {
      access = undefined;
    },

    signOut() {
      access = undefined;
      storage.removeItem(key);
    },
  };
}

export type BrowserAuth = ReturnType<typeof createBrowserAuth>;
