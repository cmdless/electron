// Which provider a host signals through, as settings: what an app keeps in
// its config, takes from its command line, and turns into a provider at
// runtime - the same everywhere, so every app configures it alike.

import { dropboxApp, dropboxSignaling } from './dropbox.js';
import { ONEDRIVE_ME, oneDriveApp, oneDriveFolder, oneDriveSignaling } from './onedrive.js';
import type { SignalingProvider } from './providers.js';

export type ProviderSettings =
  // a Dropbox app's App folder: cmdless's own app, or yours by its key and a
  // redirect URI registered for it
  | { kind: 'dropbox'; appKey?: string; redirectUri?: string }
  // a folder every device can write to, such as one a sync client keeps in
  // step - node only
  | { kind: 'folder'; path: string }
  // the App folder on a OneDrive or SharePoint drive, through an Entra app:
  // its tenant and client id, the drive as a Graph path (the user's own if
  // it's left out), and a redirect URI registered for the app
  // (http://localhost if it's left out)
  | { kind: 'onedrive'; tenantId: string; clientId: string; drive?: string; redirectUri?: string };

export type ProviderKind = ProviderSettings['kind'];

// the OAuth app a provider's account is signed in to, through whatever holds
// sign-ins (the auth broker) - none for a folder
export function accountOf(provider: ProviderSettings) {
  switch (provider.kind) {
    case 'dropbox': return dropboxApp(provider.appKey, provider.redirectUri);
    case 'onedrive': return oneDriveApp(provider.tenantId, provider.clientId, provider.redirectUri);
    case 'folder': return undefined;
  }
}

// what people call it - the account's name, for one that has an account
export function providerName(provider: ProviderSettings) {
  switch (provider.kind) {
    case 'dropbox': return 'Dropbox';
    case 'onedrive': return 'OneDrive';
    case 'folder': return 'a folder';
  }
}

// what people call it, with which one it is
export function providerLabel(provider: ProviderSettings) {
  switch (provider.kind) {
    case 'dropbox': return provider.appKey ? `Dropbox (app ${provider.appKey})` : 'Dropbox';
    case 'onedrive': return !provider.drive || provider.drive === ONEDRIVE_ME ? 'OneDrive' : `OneDrive (${provider.drive})`;
    case 'folder': return provider.path;
  }
}

const absolute = (path: string) => path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\');

// a provider setting, checked - throws saying what's wrong
export function validProvider(provider: ProviderSettings): ProviderSettings {
  const nonEmpty = (value: unknown, what: string) => {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${what} can't be empty`);
  };
  const url = (value: string | undefined) => {
    if (value !== undefined && !URL.canParse(value)) throw new Error(`${value} isn't a URL`);
  };
  switch (provider?.kind) {
    case 'dropbox':
      if (provider.appKey !== undefined) nonEmpty(provider.appKey, 'a Dropbox app key');
      if (provider.redirectUri !== undefined && provider.appKey === undefined) throw new Error('a redirect URI goes with an app key');
      url(provider.redirectUri);
      return provider;
    case 'folder':
      if (typeof provider.path !== 'string' || !absolute(provider.path)) throw new Error('a folder provider needs a full path');
      return provider;
    case 'onedrive':
      nonEmpty(provider.tenantId, 'a tenant id');
      nonEmpty(provider.clientId, 'a client id');
      oneDriveFolder(provider.drive);
      url(provider.redirectUri);
      return provider;
    default:
      throw new Error('the provider is dropbox, folder or onedrive');
  }
}

// how a command line sets it, for an app's usage - each line indented by
// indent, and each form after command
export const providerUsage = (command: string, indent = '  ') => PROVIDER_USAGE
  .replace(/^provider/gm, `${command} provider`).replace(/^/gm, indent);

const PROVIDER_USAGE = `provider dropbox [<app key> [<redirect URI>]]
    Dropbox's App folder: cmdless's own app, or yours by its key and one of
    its registered redirect URIs (http://localhost/cmdless-auth if left out)
provider folder <path>
    a folder every device can write to, such as one a sync client keeps
provider onedrive <tenant id> <client id> [<drive> [<redirect URI>]]
    the App folder on a OneDrive drive, through an Entra app (Mobile and
    desktop, redirect http://localhost if left out). The drive is a Graph
    path: /me/drive (the default) for one user's devices, or one everyone
    shares - /drives/{driveId} or /sites/{siteId}/drive`;

// the provider a command line gives, after 'provider': its kind and its
// arguments - a folder's path made absolute by resolve
export function parseProvider([kind, ...rest]: string[], resolve: (path: string) => string = path => path): ProviderSettings {
  const [first, second, third, fourth] = rest;
  switch (kind) {
    case 'dropbox':
      return validProvider({ kind, ...first !== undefined && { appKey: first }, ...second !== undefined && { redirectUri: second } });
    case 'folder':
      if (first === undefined) throw new Error('provider folder takes the folder');
      return validProvider({ kind, path: resolve(first) });
    case 'onedrive':
      if (first === undefined || second === undefined) throw new Error('provider onedrive takes a tenant id and a client id');
      return validProvider({
        kind, tenantId: first, clientId: second,
        ...third !== undefined && { drive: third },
        ...fourth !== undefined && { redirectUri: fourth },
      });
    default:
      throw new Error('the provider is dropbox, folder or onedrive');
  }
}

// a token for a provider's account: from whatever holds its sign-in, asked
// again with retry when the provider refused the last one
export type GetToken = (retry: boolean) => Promise<string>;

// the provider its settings name, for one with an account - a folder is
// node's (see signalingFor there)
export function accountSignaling(provider: ProviderSettings, getToken: GetToken, signedOut?: (error: unknown) => boolean): SignalingProvider {
  switch (provider.kind) {
    case 'dropbox': return dropboxSignaling(getToken, signedOut);
    case 'onedrive': return oneDriveSignaling(getToken, provider.drive, signedOut);
    case 'folder': throw new Error('a folder provider is node\'s - use signalingFor from @cmdless/rtc-sdk/node');
  }
}
