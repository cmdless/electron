import { fileURLToPath } from 'node:url';
import { isPendingService, listenExclusive, rejectService, resolveService } from '@cmdless/core/node';
import type { DaemonService } from '@cmdless/core/node';
import { memory } from '@cmdless/rpc-sdk';
import { createSocketServer, file } from '@cmdless/rpc-sdk/node';
import { dropboxApp, dropboxSignaling, folderSignaling, getPeerlinkSocketPath, peerlinkProtocol } from '@cmdless/peerlink-sdk/node';
import type { AccountState, OfferParams, ProviderSettings } from '@cmdless/peerlink-sdk';
import { ensureAuth, providerKey } from '@cmdless/auth-sdk/node';
import type { ProviderStatus } from '@cmdless/auth-sdk/node';
import { createSync } from './sync.js';
import { defaultSettings, providerLabel, settingsPath, validSettings } from './settings.js';
import { showTrayWhileSet } from './tray.js';

// what a client sent, checked before it becomes an offer
function validOffer({ kind, name, address }: OfferParams): OfferParams {
  if (!kind || !name) throw new Error('an offer needs a kind and a name');
  const url = new URL(address);
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new Error(`an offer's address must be a WebSocket URL, not ${url.protocol}`);
  return { kind, name, address };
}

async function main() {
  const createPeerlinkHost = peerlinkProtocol.defineHost({
    state: {
      host: memory({ pid: process.pid, status: 'starting', tray: 'off' }),
      offers: memory({}),
      settings: file(settingsPath(), { default: defaultSettings() }),
      account: memory<AccountState>({ status: 'signed-out' }),
      devices: memory({}),
    },
    configure: (server, store) => {
      // the offers this connection made - they go when it does
      const leased = new Set<string>();
      const withdraw = (ids: Iterable<string>) => store.update('offers', offers => {
        for (const id of ids) delete offers[id];
      });

      server.onRequest.offer(async params => {
        const offer = { id: crypto.randomUUID(), ...validOffer(params) };
        leased.add(offer.id);
        await store.update('offers', offers => { offers[offer.id] = offer; });
        return { id: offer.id };
      });
      server.onRequest.withdraw(async ({ id }) => {
        if (!leased.delete(id)) throw new Error(`this connection holds no offer ${id}`);
        await withdraw([id]);
      });
      server.onRequest.updateSettings(async update => {
        const valid = validSettings(update);
        await store.update('settings', settings => ({ ...settings, ...valid }));
      });
      server.onRequest.signIn(() => signIn());
      server.onRequest.signOut(() => signOut());
      // answered before it goes, so whoever asked hears it worked
      server.onRequest.stop(() => { setImmediate(() => void stop()); });
      server.onClose(() => { void withdraw(leased); });
    },
  });
  const { store, accept } = await createPeerlinkHost();

  // the socket is the lock: whoever listens on it is the one daemon
  const lock = createSocketServer(accept);
  const service: DaemonService = { address: getPeerlinkSocketPath() };
  if (!await listenExclusive(lock, service.address)) {
    // another daemon won the race - it lives at the same address
    if (isPendingService()) await resolveService(service);
    return;
  }

  // a settings.json from before a setting existed gets its default for it
  await store.update('settings', settings => ({ ...defaultSettings(), ...settings }));
  await store.update('host', host => { host.status = 'ready'; });

  // the auth broker holds any Dropbox sign-in - found at start without ever
  // opening a window, or made later by signIn (here, or by anything else
  // asking the broker)
  const authDaemonPath = fileURLToPath(import.meta.resolve('@cmdless/auth/daemon'));
  const auth = await ensureAuth(authDaemonPath);
  const setAccount = (account: AccountState) => store.set({ account });

  // the provider's Dropbox app, if it's Dropbox - a folder has no account
  const appOf = (provider: ProviderSettings) => provider.kind === 'dropbox' ? dropboxApp(provider.appKey) : undefined;

  const signalingFor = (provider: ProviderSettings) => {
    if (provider.kind === 'folder') return folderSignaling(provider.path);
    const app = dropboxApp(provider.appKey);
    return dropboxSignaling(async () => (await auth.request.getToken({ provider: app, interactive: false })).accessToken);
  };

  function createSyncFor(provider: ProviderSettings) {
    return createSync({
      provider: signalingFor(provider),
      settings: () => store.state.settings,
      offers: () => store.state.offers,
      setDevices: devices => { void store.set({ devices }); },
      onStopped: reason => { void setAccount({ status: 'signed-out', error: reason }); },
      onError: reason => { void setAccount(reason ? { status: 'error', error: reason } : { status: 'syncing' }); },
      // a device that connects may open one of this device's offers, or an
      // address one of them has - nothing else
      resolveTarget: target => {
        const offers = Object.values(store.state.offers);
        if ('offerId' in target) return store.state.offers[target.offerId]?.address;
        return offers.some(offer => offer.address === target.address) ? target.address : undefined;
      },
    });
  }

  // one provider at a time: the one the settings name
  let using = '';
  let sync = createSyncFor(store.state.settings.provider);
  // the broker's sign-ins, as last heard
  let brokered: Record<string, ProviderStatus> = {};

  const startSync = () => {
    if (sync.running) return;
    void setAccount({ status: 'syncing' });
    sync.start();
  };

  // syncs while the provider's account lets it: a folder always, Dropbox
  // while the broker holds a sign-in to its app
  function follow() {
    const app = appOf(store.state.settings.provider);
    const signIn = app ? brokered[providerKey(app)] : { status: 'signed-in' as const };
    if (signIn?.status === 'signed-in') startSync();
    else if (signIn?.status === 'signed-out' && sync.running) {
      void sync.stop(false);
      void setAccount({ status: 'signed-out', error: signIn.error });
    }
  }

  // the provider setting changing: this device is marked offline through the
  // old one, and the new one takes over - one change at a time
  let switching: Promise<void> = Promise.resolve();
  const useProvider = () => switching = switching.then(async () => {
    const provider = store.state.settings.provider;
    const key = JSON.stringify(provider);
    if (key === using) return;
    const first = using === '';
    using = key;
    if (!first) {
      await sync.stop(true);
      sync = createSyncFor(provider);
      await setAccount({ status: 'signed-out' });
      console.error(`peerlink: now syncing through ${providerLabel(provider)}`);
    }
    follow();
  });

  async function signIn() {
    const app = appOf(store.state.settings.provider);
    if (!app) throw new Error(`${providerLabel(store.state.settings.provider)} has no account to sign in to`);
    await setAccount({ status: 'signing-in' });
    try {
      await auth.request.getToken({ provider: app, interactive: true });
    } catch (error) {
      await setAccount({ status: 'signed-out', error: (error as Error).message });
      throw error;
    }
    startSync();
  }

  async function signOut() {
    const app = appOf(store.state.settings.provider);
    if (!app) throw new Error(`${providerLabel(store.state.settings.provider)} has no account to sign out of`);
    await sync.stop(true);
    await auth.request.signOut({ provider: app });
    await setAccount({ status: 'signed-out' });
  }

  await auth.state.providers.subscribe(providers => {
    brokered = providers;
    follow();
  });
  await useProvider();

  // anything in the advertisement changing gets written right away - and the
  // provider changing switches to it
  store.watch('offers', () => sync.changed());
  store.watch('settings', () => {
    sync.changed();
    void useProvider();
  });

  // a tray while the setting says so
  const tray = showTrayWhileSet(store, { signIn, signOut, stop: () => stop() });

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    // tells the other devices this one is gone, rather than leaving them to
    // notice the heartbeat stop - but never holds up shutting down for long
    await Promise.race([sync.stop(true), new Promise(resolve => setTimeout(resolve, 3_000))]);
    tray.dispose();
    auth.dispose();
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
