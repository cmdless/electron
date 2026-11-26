import { defineProtocol } from '@cmdless/rpc-sdk';
import type { IceServer, ProviderSettings } from '@cmdless/rtc-sdk';

// Peerlink is one RTC host per device (@cmdless/rtc-sdk) with a registry of
// offers on top: what it advertises is its offers, and a channel opened to
// it names the offer it's for.

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

// what carries this device's advertisement and its signaling - one at a
// time, as rtc-sdk configures any host's
export type { ProviderSettings };

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

// what a device's host advertises about it - its offers, never their addresses
export type PeerlinkInfo = { offers: Record<string, AdvertisedOffer> };

// what a data channel opens on a device: one of its offers, or an address
// one of its offers has (learned through that offer's own protocol)
export type LinkTarget = { offerId: string } | { address: string };

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
