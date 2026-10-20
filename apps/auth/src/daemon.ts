import path from 'node:path';
import { getAppDataPath, isPendingService, listenExclusive, rejectService, resolveService } from '@cmdless/core/node';
import type { DaemonService } from '@cmdless/core/node';
import { memory } from '@cmdless/rpc-sdk';
import { createSocketServer } from '@cmdless/rpc-sdk/node';
import { CmdlessUI } from '@cmdless/ui-sdk/node';
import { authProtocol, getAuthSocketPath, providerKey } from '@cmdless/auth-sdk/node';
import type { AccessToken, OAuthProvider, ProviderStatus } from '@cmdless/auth-sdk';
import { codeFrom, exchangeCode, refresh, startSignIn, TokenRefused } from './oauth.js';
import type { Tokens } from './oauth.js';
import { createTokenFiles } from './tokens.js';

const tokens = createTokenFiles(path.join(getAppDataPath('auth'), 'tokens'));

// a token this close to expiring is refreshed rather than handed out
const EXPIRY_MARGIN_MS = 60_000;

const fresh = ({ expiresAt }: Tokens) => !expiresAt || Date.parse(expiresAt) - EXPIRY_MARGIN_MS > Date.now();

async function main() {
  const createAuthHost = authProtocol.defineHost({
    state: {
      host: memory({ pid: process.pid, status: 'starting' }),
      providers: memory(Object.fromEntries(tokens.all().map(({ key, expiresAt }): [string, ProviderStatus] =>
        [key, { status: 'signed-in', expiresAt }]))),
    },
    configure: server => {
      server.onRequest.getToken(({ provider, interactive = true }) => getToken(provider, interactive));
      server.onRequest.signOut(async ({ provider }) => {
        const key = providerKey(provider);
        tokens.remove(key);
        await setStatus(key, { status: 'signed-out' });
      });
    },
  });
  const { store, accept } = await createAuthHost();

  const setStatus = (key: string, status: ProviderStatus) =>
    store.update('providers', providers => { providers[key] = status; });

  function keep(key: string, next: Tokens, previous?: Tokens): AccessToken {
    // a refresh may not send a new refresh token - the old one still holds
    const refreshToken = next.refreshToken ?? previous?.refreshToken;
    tokens.write({ key, ...next, refreshToken });
    void setStatus(key, { status: 'signed-in', expiresAt: next.expiresAt });
    return { accessToken: next.accessToken, expiresAt: next.expiresAt };
  }

  // only one sign-in window at a time, whatever it's for
  let windows: Promise<unknown> = Promise.resolve();
  function oneWindowAtATime<T>(open: () => Promise<T>): Promise<T> {
    const opened = windows.then(open, open);
    windows = opened.catch(() => { });
    return opened;
  }

  async function signIn(provider: OAuthProvider, key: string): Promise<AccessToken> {
    return oneWindowAtATime(async () => {
      await setStatus(key, { status: 'signing-in' });
      try {
        const attempt = startSignIn(provider);
        const redirectedTo = await new CmdlessUI().show({
          kind: 'show', type: 'url', source: attempt.url,
          app: 'cmdless-auth', width: 520, height: 720,
          redirect: provider.redirectUri,
        });
        // the window resolves to nothing when it's closed instead
        if (!redirectedTo.startsWith(provider.redirectUri)) throw new Error('sign-in cancelled');
        const code = codeFrom(redirectedTo, attempt.state);
        return keep(key, await exchangeCode(provider, code, attempt.verifier));
      } catch (error) {
        await setStatus(key, { status: 'signed-out', error: (error as Error).message });
        throw error;
      }
    });
  }

  async function resolveToken(provider: OAuthProvider, interactive: boolean): Promise<AccessToken> {
    const key = providerKey(provider);
    const stored = tokens.read(key);
    if (stored && fresh(stored)) return { accessToken: stored.accessToken, expiresAt: stored.expiresAt };

    if (stored?.refreshToken) {
      try {
        return keep(key, await refresh(provider, stored.refreshToken), stored);
      } catch (error) {
        // a refused refresh token is no good any more; anything else (no
        // network, say) leaves it alone for the next try
        if (!(error instanceof TokenRefused)) throw error;
        tokens.remove(key);
        await setStatus(key, { status: 'signed-out', error: `the stored sign-in no longer works: ${error.message}` });
      }
    }

    if (!interactive) throw new Error(`not signed in to ${provider.id}`);
    return signIn(provider, key);
  }

  // callers asking for the same provider at once share one answer (and so
  // one window); an interactive ask doesn't join a non-interactive one, which
  // could fail where it would have opened a window
  const inFlight = new Map<string, Promise<AccessToken>>();
  function getToken(provider: OAuthProvider, interactive: boolean) {
    const flight = `${providerKey(provider)}:${interactive}`;
    let answer = inFlight.get(flight);
    if (!answer) {
      answer = resolveToken(provider, interactive).finally(() => inFlight.delete(flight));
      inFlight.set(flight, answer);
    }
    return answer;
  }

  // the socket is the lock: whoever listens on it is the one broker
  const lock = createSocketServer(accept);
  const service: DaemonService = { address: getAuthSocketPath() };
  if (!await listenExclusive(lock, service.address)) {
    if (isPendingService()) await resolveService(service);
    return;
  }

  await store.update('host', host => { host.status = 'ready'; });

  const stop = () => {
    lock.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  if (isPendingService()) await resolveService(service);
}

main().catch(async error => {
  console.error(error);
  if (isPendingService()) await rejectService(error).catch(() => { });
  process.exit(1);
});
