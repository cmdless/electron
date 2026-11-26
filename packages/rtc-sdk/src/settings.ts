// Which provider a host signals through, as settings: what an app keeps in
// its config, takes from its command line, and turns into a provider at
// runtime - the same everywhere, so every app configures it alike.

import { dropboxApp, dropboxSignaling } from './dropbox.js';
import { graphApp, graphAppFolderPath, graphAppFolderSignaling } from './graph.js';
import type { GraphAppFolder } from './graph.js';
import type { SignalingProvider } from './providers.js';

// a Dropbox app's App folder: cmdless's own app, or yours by its key and a
// redirect URI registered for it
export type DropboxProvider = { kind: 'dropbox'; appKey?: string; redirectUri?: string };

// a folder every device can write to, such as one a sync client keeps in
// step - node only
export type FolderProvider = { kind: 'folder'; path: string };

// the App folder on a OneDrive or SharePoint drive, through Microsoft Graph
// and an Entra app: its tenant and client id, which drive's App folder, and
// a redirect URI registered for the app (http://localhost if it's left out)
export type GraphAppFolderProvider = {
  kind: 'graph-app-folder';
  tenantId: string;
  clientId: string;
  folder: GraphAppFolder;
  redirectUri?: string;
};

export type ProviderSettings = DropboxProvider | FolderProvider | GraphAppFolderProvider;

export type ProviderKind = ProviderSettings['kind'];

// the OAuth app a provider's account is signed in to, through whatever holds
// sign-ins (the auth broker) - none for a folder
export function accountOf(provider: ProviderSettings) {
  switch (provider.kind) {
    case 'dropbox': return dropboxApp(provider.appKey, provider.redirectUri);
    case 'graph-app-folder': return graphApp(provider.tenantId, provider.clientId, provider.redirectUri);
    case 'folder': return undefined;
  }
}

// what people call it - the account's name, for one that has an account
export function providerName(provider: ProviderSettings) {
  switch (provider.kind) {
    case 'dropbox': return 'Dropbox';
    case 'graph-app-folder': return provider.folder.type === 'site' ? 'SharePoint' : 'OneDrive';
    case 'folder': return 'a folder';
  }
}

// what people call it, with which one it is
export function providerLabel(provider: ProviderSettings) {
  switch (provider.kind) {
    case 'dropbox': return provider.appKey ? `Dropbox (app ${provider.appKey})` : 'Dropbox';
    case 'graph-app-folder': {
      const { folder } = provider;
      return folder.type === 'personal' ? 'OneDrive'
        : folder.type === 'drive' ? `OneDrive (drive ${folder.driveId})`
          : `SharePoint (site ${folder.siteId})`;
    }
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
    case 'graph-app-folder':
      nonEmpty(provider.tenantId, 'a tenant id');
      nonEmpty(provider.clientId, 'a client id');
      graphAppFolderPath(provider.folder);
      url(provider.redirectUri);
      return provider;
    default:
      throw new Error('the provider is dropbox, folder or graph-app-folder');
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
provider graph-app-folder <tenant id> <client id> [personal | drive <drive id> | site <site id>] [<redirect URI>]
    the App folder on a OneDrive or SharePoint drive, through an Entra app
    (Mobile and desktop, redirect http://localhost if left out): your own
    OneDrive's (personal, the default) for your own devices, or one everyone
    shares - a document library's by its drive id, or a SharePoint site's
    default library's`;

// the provider a command line gives, after 'provider': its kind and its
// arguments - a folder's path made absolute by resolve
export function parseProvider([kind, ...rest]: string[], resolve: (path: string) => string = path => path): ProviderSettings {
  switch (kind) {
    case 'dropbox': {
      const [appKey, redirectUri] = rest;
      return validProvider({ kind, ...appKey !== undefined && { appKey }, ...redirectUri !== undefined && { redirectUri } });
    }
    case 'folder':
      if (rest[0] === undefined) throw new Error('provider folder takes the folder');
      return validProvider({ kind, path: resolve(rest[0]) });
    case 'graph-app-folder': {
      const [tenantId, clientId, type, ...more] = rest;
      if (tenantId === undefined || clientId === undefined) throw new Error('provider graph-app-folder takes a tenant id and a client id');
      let folder: GraphAppFolder = { type: 'personal' };
      let after = type === undefined || type === 'personal' ? more : [type, ...more];
      if (type === 'drive' || type === 'site') {
        const [id, ...left] = more;
        if (id === undefined) throw new Error(`a ${type}'s App folder takes the ${type}'s id`);
        folder = type === 'drive' ? { type, driveId: id } : { type, siteId: id };
        after = left;
      }
      const [redirectUri, extra] = after;
      if (extra !== undefined) throw new Error(`provider graph-app-folder doesn't take ${extra}`);
      return validProvider({ kind, tenantId, clientId, folder, ...redirectUri !== undefined && { redirectUri } });
    }
    default:
      throw new Error('the provider is dropbox, folder or graph-app-folder');
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
    case 'graph-app-folder': return graphAppFolderSignaling(getToken, provider.folder, signedOut);
    case 'folder': throw new Error('a folder provider is node\'s - use signalingFor from @cmdless/rtc-sdk/node');
  }
}
