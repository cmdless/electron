import type { Advertisement, Device, LinkTarget, Offer, SettingsState, SignalingProvider, Watch } from '@cmdless/peerlink-sdk';
import { answerLinks } from './links.js';
import { DEFAULT_HEARTBEAT_SECONDS } from './settings.js';

type SyncOptions = {
  provider: SignalingProvider;
  settings: () => SettingsState;
  offers: () => Record<string, Offer>;
  setDevices: (devices: Record<string, Device>) => void;
  // a failure the sync can't get past by itself (no token, a refused one)
  onStopped: (reason: string) => void;
  onError: (reason: string | undefined) => void;
  // the local address a connecting device's channel opens, if it may
  resolveTarget: (target: LinkTarget) => string | undefined;
};

const heartbeatOf = (settings: SettingsState) => settings.heartbeatSeconds ?? DEFAULT_HEARTBEAT_SECONDS;

// keeps this device's advertisement written - on change and every heartbeat
// - and the other devices' read, for as long as it runs
export function createSync(options: SyncOptions) {
  const { provider } = options;
  let watcher: Watch | undefined;
  let links: ReturnType<typeof answerLinks> | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let publishing: Promise<void> = Promise.resolve();

  const advertisement = (online: boolean): Advertisement => {
    const settings = options.settings();
    return {
      version: 1,
      deviceId: settings.deviceId,
      name: settings.deviceName,
      updatedAt: new Date().toISOString(),
      heartbeatSeconds: heartbeatOf(settings),
      online,
      offers: Object.fromEntries(Object.values(options.offers()).map(({ id, kind, name }) => [id, { id, kind, name }])),
      iceServers: settings.iceServers,
    };
  };

  // one write at a time, always of the state as it is when it runs
  function publish(online = true) {
    publishing = publishing.catch(() => { }).then(async () => {
      await provider.publish(advertisement(online));
    });
    return publishing;
  }

  const reasonOf = (error: unknown) => String((error as Error)?.message ?? error);

  function stop(markOffline: boolean) {
    if (!watcher) return Promise.resolve();
    watcher.stop();
    links?.stop();
    links = undefined;
    watcher = undefined;
    clearInterval(heartbeat);
    options.setDevices({});
    return markOffline ? publish(false).catch(() => { }) : Promise.resolve();
  }

  const failed = (error: unknown): 'stop' | 'retry' => {
    if (provider.needsPerson(error)) {
      void stop(false);
      options.onStopped(reasonOf(error));
      return 'stop';
    }
    options.onError(reasonOf(error));
    return 'retry';
  };

  return {
    get running() { return !!watcher; },
    start() {
      if (watcher) return;
      heartbeat = setInterval(() => publish().catch(failed), heartbeatOf(options.settings()) * 1000);
      // written first, so the other devices (and the watch) see this one right away
      publish().catch(failed);
      links = answerLinks({
        provider,
        deviceId: options.settings().deviceId,
        iceServers: () => options.settings().iceServers,
        resolveTarget: options.resolveTarget,
        onError: failed,
      });
      watcher = provider.watchDevices({
        ownDeviceId: options.settings().deviceId,
        onChange: options.setDevices,
        onError: failed,
        onReady: () => options.onError(undefined),
      });
    },
    stop,
    // something in the advertisement changed - write it now
    changed() {
      if (watcher) publish().catch(failed);
    },
  };
}
