import { createHash, randomBytes } from 'node:crypto';
import type { OAuthProvider } from '@cmdless/auth-sdk';

// what a provider's token endpoint answers
type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

export type Tokens = { accessToken: string; refreshToken?: string; expiresAt?: string };

// a token endpoint refused the request outright (as opposed to being
// unreachable) - for a refresh, that means the refresh token is no good
export class TokenRefused extends Error { }

const base64url = (bytes: Buffer) => bytes.toString('base64url');

// everything a PKCE sign-in needs for one attempt: where to send the person,
// and what to check and send back once they return
export function startSignIn(provider: OAuthProvider) {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  const state = base64url(randomBytes(16));

  const url = new URL(provider.authorizeUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', provider.clientId);
  url.searchParams.set('redirect_uri', provider.redirectUri);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  if (provider.scopes?.length) url.searchParams.set('scope', provider.scopes.join(' '));
  for (const [key, value] of Object.entries(provider.extraParams ?? {}))
    url.searchParams.set(key, value);

  return { url: url.toString(), verifier, state };
}

// the code from the URL the provider redirected to, once it's checked
export function codeFrom(redirectedTo: string, expectedState: string) {
  const params = new URL(redirectedTo).searchParams;
  const error = params.get('error');
  if (error) throw new Error(`sign-in failed: ${params.get('error_description') ?? error}`);
  if (params.get('state') !== expectedState) throw new Error('sign-in failed: the state didn\'t match');
  const code = params.get('code');
  if (!code) throw new Error('sign-in failed: no code came back');
  return code;
}

async function requestTokens(provider: OAuthProvider, form: Record<string, string>): Promise<Tokens> {
  const response = await fetch(provider.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: provider.clientId, ...form }),
  });
  const body = await response.json().catch(() => ({})) as TokenResponse;
  if (!response.ok || !body.access_token) {
    const reason = body.error_description ?? body.error ?? `${response.status} ${response.statusText}`;
    if (response.status >= 400 && response.status < 500) throw new TokenRefused(reason);
    throw new Error(reason);
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: body.expires_in ? new Date(Date.now() + body.expires_in * 1000).toISOString() : undefined,
  };
}

export function exchangeCode(provider: OAuthProvider, code: string, verifier: string) {
  return requestTokens(provider, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: provider.redirectUri,
    code_verifier: verifier,
  });
}

export function refresh(provider: OAuthProvider, refreshToken: string) {
  return requestTokens(provider, { grant_type: 'refresh_token', refresh_token: refreshToken });
}
