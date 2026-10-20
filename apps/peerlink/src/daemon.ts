import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAppDataPath, isPendingService, listenExclusive, rejectService, resolveService } from '@cmdless/core/node';
import type { DaemonService } from '@cmdless/core/node';
import { memory } from '@cmdless/rpc-sdk';
import { createSocketServer, file } from '@cmdless/rpc-sdk/node';
import { dropboxApp, getPeerlinkSocketPath, peerlinkProtocol } from '@cmdless/peerlink-sdk/node';
import type { AccountState, OfferParams, SettingsState, SettingsUpdate } from '@cmdless/peerlink-sdk';
import { ensureAuth, providerKey } from '@cmdless/auth-sdk/node';
import { createSync, DEFAULT_HEARTBEAT_SECONDS } from './sync.js';

const dataPath = getAppDataPath('peerlink');

const defaultSettings = (): SettingsState => ({
  deviceId: crypto.randomUUID(),
  deviceName: os.hostname(),
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  heartbeatSeconds: DEFAULT_HEARTBEAT_SECONDS,
});

// what a client sent, checked before it becomes an offer
function validOffer({ kind, name, address }: OfferParams): OfferParams {
  if (!kind || !name) throw new Error('an offer needs a kind and a name');
  const url = new URL(address);
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new Error(`an offer's address must be a WebSocket URL, not ${url.protocol}`);
  return { kind, name, address };
}

function validSettings(update: SettingsUpdate): SettingsUpdate {
  const { deviceName, iceServers, heartbeatSeconds } = update;
  if (deviceName !== undefined && !deviceName.trim()) throw new Error('a device name can\'t be empty');
  if (iceServers !== undefined && !iceServers.every(server => server?.urls)) throw new Error('every ICE server needs urls');
  if (heartbeatSeconds !== undefined && !(heartbeatSeconds >= 15)) throw new Error('a heartbeat must be at least 15 seconds');
  return {
    ...(deviceName !== undefined && { deviceName }),
    ...(iceServers !== undefined && { iceServers }),
    ...(heartbeatSeconds !== undefined && { heartbeatSeconds }),
  };
}

async function main() {
  const createPeerlinkHost = peerlinkProtocol.defineHost({
    state: {
      host: memory({ pid: process.pid, status: 'starting' }),
      offers: memory({}),
      settings: file(path.join(dataPath, 'settings.json'), { default: defaultSettings() }),
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

  await store.update('host', host => { host.status = 'ready'; });

  // Dropbox, through the auth broker: syncs whenever the broker holds a
  // Dropbox sign-in - found at start without ever opening a window, or
  // made later by signIn (here, or by anything else asking the broker)
  const authDaemonPath = fileURLToPath(import.meta.resolve('@cmdless/auth/daemon'));
  const auth = await ensureAuth(authDaemonPath);
  const setAccount = (account: AccountState) => store.set({ account });

  const sync = createSync({
    getToken: async () => (await auth.request.getToken({ provider: dropboxApp, interactive: false })).accessToken,
    settings: () => store.state.settings,
    offers: () => store.state.offers,
    setDevices: edit => { void store.update('devices', devices => { edit(devices); }); },
    onStopped: reason => { void setAccount({ status: 'signed-out', error: reason }); },
    onError: reason => { void setAccount(reason ? { status: 'error', error: reason } : { status: 'syncing' }); },
  });
  const startSync = () => {
    if (sync.running) return;
    void setAccount({ status: 'syncing' });
    sync.start();
  };

  async function signIn() {
    await setAccount({ status: 'signing-in' });
    try {
      await auth.request.getToken({ provider: dropboxApp, interactive: true });
    } catch (error) {
      await setAccount({ status: 'signed-out', error: (error as Error).message });
      throw error;
    }
    startSync();
  }

  async function signOut() {
    await sync.stop(true);
    await auth.request.signOut({ provider: dropboxApp });
    await setAccount({ status: 'signed-out' });
  }

  // the broker's sign-in status is what starts and stops syncing
  const key = providerKey(dropboxApp);
  await auth.state.providers.subscribe(providers => {
    const status = providers[key]?.status;
    if (status === 'signed-in') startSync();
    else if (status === 'signed-out' && sync.running) {
      void sync.stop(false);
      void setAccount({ status: 'signed-out', error: providers[key]?.error });
    }
  });

  // anything in the advertisement changing gets written right away
  store.watch('offers', () => sync.changed());
  store.watch('settings', () => sync.changed());

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    // tells the other devices this one is gone, rather than leaving them to
    // notice the heartbeat stop - but never holds up shutting down for long
    await Promise.race([sync.stop(true), new Promise(resolve => setTimeout(resolve, 3_000))]);
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
