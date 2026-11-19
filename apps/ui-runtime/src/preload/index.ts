import { BACKEND_ARG, cmdlessIPC, cmdlessViewIPC, createElectronIPC, createElectronViewIPC } from '@cmdless/ui-sdk';
import type { Cmdless, CmdlessSocket } from '@cmdless/ui-sdk';
import { contextBridge, ipcRenderer } from 'electron';

const ipc = cmdlessIPC.createClient(createElectronIPC(ipcRenderer));
// the host's own views (a card, a form) talk on this - other pages never hear
// from it
const view = cmdlessViewIPC.createClient(createElectronViewIPC(ipcRenderer));

// connects to the window's backend: the host asks the window's UIHost where
// it is, with a token for one connection. The token and the address stay
// here - the page only gets to send and hear messages.
async function connect(): Promise<CmdlessSocket> {
  const { url, token } = await ipc.request.connect();
  const socket = new WebSocket(`${url}/?token=${encodeURIComponent(token)}`);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('couldn\'t reach the window\'s backend')), { once: true });
  });

  // what arrives before the page listens is kept for it: the backend may
  // speak first, while the page is still setting up
  const early: string[] = [];
  let deliver: ((message: string) => void) | undefined;
  socket.addEventListener('message', event => {
    const message = String(event.data);
    if (deliver) deliver(message);
    else early.push(message);
  });

  return {
    send: message => socket.send(message),
    onMessage: listener => {
      deliver = listener;
      for (const message of early.splice(0)) listener(message);
    },
    onClose: listener => socket.addEventListener('close', event => listener(event.code, event.reason)),
    close: () => socket.close(),
  };
}

ipc.listen();
view.listen();

// the host says at start whether the window has a backend, so the page can
// tell without asking - and the connection is underway before it does
const backend = process.argv.includes(BACKEND_ARG) ? connect() : undefined;
// a page that never takes it up isn't left with an unhandled failure here
backend?.catch(() => { });

const cmdless: Cmdless = {
  resolve: (value, exitCode) => ipc.notify.resolve({ value, exitCode }),
  backend,
  connect,
  view,
};

contextBridge.exposeInMainWorld('cmdless', cmdless);
