import os from 'node:os';
import path from 'node:path';
import { getAppDataPath, isPendingService, listenExclusive, rejectService, resolveService } from '@cmdless/core/node';
import type { DaemonService } from '@cmdless/core/node';
import { memory } from '@cmdless/rpc-sdk';
import { createSocketServer, file } from '@cmdless/rpc-sdk/node';
import { getPeerlinkSocketPath, peerlinkProtocol } from '@cmdless/peerlink-sdk/node';
import type { OfferParams, SettingsState, SettingsUpdate } from '@cmdless/peerlink-sdk';

const dataPath = getAppDataPath('peerlink');

const defaultSettings = (): SettingsState => ({
  deviceId: crypto.randomUUID(),
  deviceName: os.hostname(),
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
});

// what a client sent, checked before it becomes an offer
function validOffer({ kind, name, address }: OfferParams): OfferParams {
  if (!kind || !name) throw new Error('an offer needs a kind and a name');
  const url = new URL(address);
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new Error(`an offer's address must be a WebSocket URL, not ${url.protocol}`);
  return { kind, name, address };
}

function validSettings(update: SettingsUpdate): SettingsUpdate {
  const { deviceName, iceServers } = update;
  if (deviceName !== undefined && !deviceName.trim()) throw new Error('a device name can\'t be empty');
  if (iceServers !== undefined && !iceServers.every(server => server?.urls)) throw new Error('every ICE server needs urls');
  return { ...(deviceName !== undefined && { deviceName }), ...(iceServers !== undefined && { iceServers }) };
}

async function main() {
  const createPeerlinkHost = peerlinkProtocol.defineHost({
    state: {
      host: memory({ pid: process.pid, status: 'starting' }),
      offers: memory({}),
      settings: file(path.join(dataPath, 'settings.json'), { default: defaultSettings() }),
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
