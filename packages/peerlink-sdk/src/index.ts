import { defineProtocol } from '@cmdless/rpc-sdk';

export * from './dropbox.js';
export * from './providers.js';
export * from './pipes.js';
export * from './signaling.js';

// an offer as this device keeps it - its address never leaves the machine
export type Offer = {
  id: string;
  // what it speaks, so a client knows how to talk to it: 'hangar', 'ahp', ...
  kind: string;
  // what people see
  name: string;
  // where peerlink reaches it locally, token included
  address: string;
};

// an offer as other devices see it: no address
export type AdvertisedOffer = Omit<Offer, 'address'>;

export type IceServer = { urls: string | string[]; username?: string; credential?: string };

// what carries this device's advertisement and its signaling - one at a
// time: Dropbox (peerlink's own app, or yours by its key and a redirect URI
// registered for it), or a folder every device can write to, such as one a
// sync client keeps in step
export type ProviderSettings =
  | { kind: 'dropbox'; appKey?: string; redirectUri?: string }
  | { kind: 'folder'; path: string };

// settings.json
export type SettingsState = {
  // generated on the first run, then stable
  deviceId: string;
  deviceName: string;
  // STUN/TURN servers for reaching other devices
  iceServers: IceServer[];
  // how often this device's advertisement is rewritten while nothing
  // changes - a device is offline once it misses three
  heartbeatSeconds: number;
  // whether the daemon shows a tray, whoever started it
  tray: boolean;
  provider: ProviderSettings;
};

// what this device tells the others through the provider, never an address
export type Advertisement = {
  version: 1;
  deviceId: string;
  name: string;
  updatedAt: string;
  heartbeatSeconds: number;
  // false once the daemon shut down cleanly
  online: boolean;
  offers: Record<string, AdvertisedOffer>;
  // the STUN/TURN servers to reach this device with
  iceServers: IceServer[];
};

export const DEVICES_FOLDER = '/devices';
export const advertisementPath = (deviceId: string) => `${DEVICES_FOLDER}/${deviceId}.json`;

// whether a device's advertisement says it's there now
export function isOnline(advertisement: Pick<Advertisement, 'online' | 'updatedAt' | 'heartbeatSeconds'>, now = Date.now()) {
  return advertisement.online && now - Date.parse(advertisement.updatedAt) < advertisement.heartbeatSeconds * 3_000;
}

// another device, as this one sees it
export type Device = {
  name: string;
  updatedAt: string;
  online: boolean;
  offers: Record<string, AdvertisedOffer>;
  iceServers: IceServer[];
};

export type AccountState = {
  status: 'signed-out' | 'signing-in' | 'syncing' | 'error';
  error?: string;
};

export type HostState = {
  pid: number;
  status: 'starting' | 'ready';
  // the tray, as the tray setting has it shown or not - and why it isn't,
  // if it couldn't be
  tray: 'off' | 'starting' | 'shown' | 'error';
  trayError?: string;
};

export type OfferParams = Omit<Offer, 'id'>;
export type SettingsUpdate = Partial<Omit<SettingsState, 'deviceId'>>;

export const peerlinkProtocol = defineProtocol(({ side, request, state }) => ({
  // bump only for a change that breaks clients - adding things doesn't
  name: 'peerlink',
  version: 1,
  clientToServer: side({
    requests: {
      // a lease: the offer lasts as long as the connection that made it
      offer: request<OfferParams, { id: string }>('offers/add'),
      withdraw: request<{ id: string }, void>('offers/remove'),
      updateSettings: request<SettingsUpdate, void>('settings/update'),
      // signs in to the provider - Dropbox: a sign-in window, through the auth
      // broker - and starts syncing; a provider with no account refuses
      signIn: request<void, void>('account/sign-in'),
      // stops syncing, marks this device offline, and signs out of the provider
      signOut: request<void, void>('account/sign-out'),
      // marks this device offline and ends the daemon, tray and all
      stop: request<void, void>('host/stop'),
    },
  }),
  state: {
    host: state<HostState>('host'),
    // this device's offers, by id
    offers: state<Record<string, Offer>>('offers'),
    settings: state<SettingsState>('settings'),
    account: state<AccountState>('account'),
    // the other devices the provider reaches, by deviceId
    devices: state<Record<string, Device>>('devices'),
  },
}));
