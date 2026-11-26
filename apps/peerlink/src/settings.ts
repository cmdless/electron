import os from 'node:os';
import path from 'node:path';
import { getAppDataPath } from '@cmdless/core/node';
import type { SettingsState, SettingsUpdate } from '@cmdless/peerlink-sdk';
import { DEFAULT_HEARTBEAT_SECONDS, DEFAULT_ICE_SERVERS, validProvider } from '@cmdless/rtc-sdk';

// settings.json: the daemon's while it runs (it reads it once and writes it
// whole on every change), anyone's while it doesn't
export const settingsPath = () => path.join(getAppDataPath('peerlink'), 'settings.json');

export const defaultSettings = (): SettingsState => ({
  deviceId: crypto.randomUUID(),
  deviceName: os.hostname(),
  iceServers: DEFAULT_ICE_SERVERS,
  heartbeatSeconds: DEFAULT_HEARTBEAT_SECONDS,
  tray: true,
  provider: { kind: 'dropbox' },
});

// a settings change, checked - only what it gives
export function validSettings(update: SettingsUpdate): SettingsUpdate {
  const { deviceName, iceServers, heartbeatSeconds, tray, provider } = update;
  if (deviceName !== undefined && !deviceName.trim()) throw new Error('a device name can\'t be empty');
  if (iceServers !== undefined && !iceServers.every(server => server?.urls)) throw new Error('every ICE server needs urls');
  if (heartbeatSeconds !== undefined && !(heartbeatSeconds >= 15)) throw new Error('a heartbeat must be at least 15 seconds');
  if (tray !== undefined && typeof tray !== 'boolean') throw new Error('tray is true or false');
  if (provider !== undefined) validProvider(provider);
  return {
    ...(deviceName !== undefined && { deviceName }),
    ...(iceServers !== undefined && { iceServers }),
    ...(heartbeatSeconds !== undefined && { heartbeatSeconds }),
    ...(tray !== undefined && { tray }),
    ...(provider !== undefined && { provider }),
  };
}
