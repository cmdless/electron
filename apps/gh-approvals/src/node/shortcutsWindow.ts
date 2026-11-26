import { memory } from '@cmdless/rpc-sdk';
import { UIHost } from '@cmdless/ui-sdk/node';
import { shortcutsProtocol } from '../shared/protocols.js';
import type { ShortcutSettings } from '../shared/shortcuts.js';
import { page } from './page.js';

export type ShortcutsWindowParams = { settings: ShortcutSettings; title?: string };

// a window with a script for each platform that starts the tray as this one
// was started
export const shortcutsWindow = UIHost.factory(async (opener, { settings, title }: ShortcutsWindowParams) => {
  const store = await shortcutsProtocol.createStore({ settings: memory(settings) });
  return opener.openWindow({
    type: 'file', source: page('/shortcuts'), window: { title, width: 760, height: 520 },
    backend: shortcutsProtocol.accept(undefined, store),
  });
});
