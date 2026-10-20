import { defineProtocol } from '@cmdless/rpc-sdk';

// an OAuth 2 provider, signed in to with PKCE - sent with each request, so
// the broker knows nothing about any provider in particular
export type OAuthProvider = {
  id: string;
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  // must match what's registered with the provider
  redirectUri: string;
  scopes?: string[];
  // anything else the authorize URL needs, e.g. Dropbox's token_access_type
  extraParams?: Record<string, string>;
};

export type ProviderStatus = {
  status: 'signed-out' | 'signing-in' | 'signed-in';
  expiresAt?: string;
  // the last failure, e.g. a revoked refresh token or a cancelled sign-in
  error?: string;
};

export type AccessToken = {
  accessToken: string;
  expiresAt?: string;
};

export type HostState = {
  pid: number;
  status: 'starting' | 'ready';
};

// where a provider's token is kept, and its status reported: two apps with
// their own client ids for the same provider never share a token
export function providerKey({ id, clientId }: Pick<OAuthProvider, 'id' | 'clientId'>) {
  return `${id}:${clientId}`;
}

export const authProtocol = defineProtocol(({ side, request, state }) => ({
  // bump only for a change that breaks clients - adding things doesn't
  name: 'auth',
  version: 1,
  clientToServer: side({
    requests: {
      // a valid access token: the stored one, refreshed when stale - or, with
      // no usable token, a sign-in window (unless interactive is false, which
      // fails instead)
      getToken: request<{ provider: OAuthProvider; interactive?: boolean }, AccessToken>('token/get'),
      signOut: request<{ provider: Pick<OAuthProvider, 'id' | 'clientId'> }, void>('token/sign-out'),
    },
  }),
  state: {
    host: state<HostState>('host'),
    // by providerKey - never holds a token
    providers: state<Record<string, ProviderStatus>>('providers'),
  },
}));
