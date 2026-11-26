import { app, Menu } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';

// Electron's own default menu, but with Quit (Cmd+Q, Ctrl+Q on Linux) doing
// what quit is given - quitting, or not, as the host decides
export function appMenu(quit: () => void) {
  const quitItem: MenuItemConstructorOptions = process.platform === 'darwin'
    ? { label: `Quit ${app.name}`, accelerator: 'Command+Q', click: quit }
    : { label: process.platform === 'win32' ? 'Exit' : 'Quit', ...process.platform === 'linux' && { accelerator: 'Ctrl+Q' }, click: quit };
  const template: MenuItemConstructorOptions[] = [
    process.platform === 'darwin'
      ? {
        label: app.name,
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          quitItem,
        ],
      }
      : { label: 'File', submenu: [quitItem] },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  return Menu.buildFromTemplate(template);
}
