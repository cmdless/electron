import { UIHost } from '@cmdless/ui-sdk/node';
import type { RemoteTray, TrayMenuItem } from '@cmdless/ui-sdk/node';
import type { RpcStore } from '@cmdless/rpc-sdk';
import type { AccountState, Device, HostState, Offer, SettingsState } from '@cmdless/peerlink-sdk';

type PeerlinkStore = RpcStore<{
  host: HostState;
  offers: Record<string, Offer>;
  settings: SettingsState;
  account: AccountState;
  devices: Record<string, Device>;
}>;

type TrayActions = {
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  stop: () => Promise<void>;
};

// The daemon's tray, shown while the tray setting is on - whoever started the
// daemon, and whenever the setting changes. It's on a throwaway UI host of
// its own (no app name), so it never meets another app's host, and it only
// ever shows what's in the store.
export function showTrayWhileSet(store: PeerlinkStore, actions: TrayActions) {
  let host: UIHost | undefined;
  let tray: RemoteTray | undefined;
  // one change at a time, each to the setting as it is when it runs
  let applying: Promise<void> = Promise.resolve();

  const setState = (state: HostState['tray'], error?: string) =>
    store.update('host', host => { host.tray = state; host.trayError = error; });

  async function show() {
    await setState('starting');
    try {
      host = await UIHost.create();
      // the host going (its process ending) takes the tray with it
      host.onClose(() => {
        if (!host) return;
        host = tray = undefined;
        void setState('error', 'the tray\'s UI host closed');
      });
      tray = await host.createTray({ icon: '', tooltip: 'peerlink', menu: menu() });
      tray.onEvent(event => {
        if (event.event !== 'menu-item') return;
        const action = { 'sign-in': actions.signIn, 'sign-out': actions.signOut, quit: actions.stop }[event.item];
        action?.().catch(error => console.error(`peerlink: ${event.item} failed:`, error));
      });
      await setState('shown');
    } catch (error) {
      hide();
      await setState('error', (error as Error).message);
    }
  }

  function hide() {
    const leaving = host;
    host = tray = undefined;
    leaving?.dispose();
  }

  function apply() {
    applying = applying.then(async () => {
      // on unless it's been turned off
      const wanted = store.state.settings.tray !== false;
      if (wanted && !host) await show();
      else if (!wanted && host) {
        hide();
        await setState('off');
      }
    });
  }

  // anything the menu shows changing redraws it - a redraw the tray's host
  // went away during (the tray being turned off, say) just doesn't happen
  const redraw = () => { void tray?.update({ menu: menu() }).catch(() => { }); };
  const watches = [
    store.watch('settings', apply),
    store.watch('settings', redraw),
    store.watch('account', redraw),
    store.watch('devices', redraw),
    store.watch('offers', redraw),
  ];
  apply();

  function menu(): TrayMenuItem[] {
    const { settings, account, devices, offers } = store.state;
    const others = Object.values(devices).sort((a, b) => a.name.localeCompare(b.name));
    const own = Object.values(offers);
    const offerItem = ({ kind, name }: { kind: string; name: string }, index: number): TrayMenuItem =>
      ({ id: `offer-${index}`, label: `${name} (${kind})`, enabled: false });
    // an error is a sync failing - still signed in
    const signedIn = account.status === 'syncing' || account.status === 'error';
    return [
      // where the storage provider's account lives - Dropbox, for now
      {
        type: 'submenu', label: 'Account', submenu: [
          { id: 'device', label: `peerlink - ${settings.deviceName}`, enabled: false },
          { type: 'separator' },
          { id: 'account', label: accountLabel(account), enabled: false },
          signedIn
            ? { id: 'sign-out', label: 'Sign Out' }
            : { id: 'sign-in', label: 'Sign In', enabled: account.status === 'signed-out' },
        ],
      },
      // what's there to see only once signed in
      ...signedIn ? [
        {
          type: 'submenu' as const, label: `Devices (${others.filter(device => device.online).length} online)`, submenu: others.length
            ? others.map(device => ({
              type: 'submenu' as const,
              label: `${device.online ? '●' : '○'} ${device.name}`,
              submenu: Object.values(device.offers).length
                ? Object.values(device.offers).map(offerItem)
                : [{ id: 'none', label: 'Offers nothing', enabled: false }],
            }))
            : [{ id: 'none', label: 'No other devices', enabled: false }],
        },
        {
          type: 'submenu' as const, label: `Offering (${own.length})`, submenu: own.length
            ? own.map(offerItem)
            : [{ id: 'none', label: 'Nothing', enabled: false }],
        },
      ] : [],
      { type: 'separator' },
      { id: 'quit', label: 'Quit peerlink' },
    ];
  }

  return {
    // takes the tray away for good - the daemon is going
    dispose() {
      for (const watch of watches) watch.dispose();
      hide();
    },
  };
}

function accountLabel(account: AccountState) {
  switch (account.status) {
    case 'signed-out': return account.error ? `Signed out: ${account.error}` : 'Signed out';
    case 'signing-in': return 'Signing in...';
    case 'syncing': return 'Syncing with Dropbox';
    case 'error': return `Error: ${account.error}`;
  }
}
