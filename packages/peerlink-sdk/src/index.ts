import { defineProtocol } from '@cmdless/rpc-sdk';

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

// settings.json
export type SettingsState = {
  // generated on the first run, then stable
  deviceId: string;
  deviceName: string;
  // STUN/TURN servers for reaching other devices
  iceServers: IceServer[];
};

export type HostState = {
  pid: number;
  status: 'starting' | 'ready';
};

export type OfferParams = Omit<Offer, 'id'>;
export type SettingsUpdate = Partial<Omit<SettingsState, 'deviceId'>>;

export const peerlinkProtocol = defineProtocol(({ side, request, state }) => ({
  clientToServer: side({
    requests: {
      // a lease: the offer lasts as long as the connection that made it
      offer: request<OfferParams, { id: string }>('offers/add'),
      withdraw: request<{ id: string }, void>('offers/remove'),
      updateSettings: request<SettingsUpdate, void>('settings/update'),
    },
  }),
  state: {
    host: state<HostState>('host'),
    // this device's offers, by id
    offers: state<Record<string, Offer>>('offers'),
    settings: state<SettingsState>('settings'),
  },
}));
