import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, shell, BrowserWindow } from 'electron';
import { electronApp, optimizer } from '@electron-toolkit/utils';
import { types } from '@cmdless/ui-sdk';
import {
  getCmdlessUIVersion, getTmpSocketPath, isEphemeralCmdlessApp, listenOnce, rejectService, resolveCmdlessApp,
  resolveService, sendTo, UIHost,
} from '@cmdless/ui-sdk/node';
import type { HostService, InitializeResult, UIServer } from '@cmdless/ui-sdk/node';
import { startSocket } from '@cmdless/rpc-sdk/node';

// the default outer-most resolve which also produces an exit code
let resolved = false;
function resolve<T>(value: T, exitCode = 0) {
  if (resolved) return;
  resolved = true;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const preloadPath = path.join(__dirname, '../preload/index.mjs');

// Electron's user agent with its own tokens (Electron/x, the app's
// name/version) taken out, leaving what Chrome sends - some sign-in pages,
// Google's among them, refuse a browser they see is embedded in an app
function browserUserAgent() {
  return app.userAgentFallback.replace(/ (?!Mozilla|AppleWebKit|Chrome|Safari)[\w.-]+\/[\w.-]+/g, '');
}

async function createWindow(parameters: types.ShowParams, finish = resolve, parent?: BrowserWindow) {
  const { app, address, type, source, width, height, redirect, title } = parameters;
  // a third party's pages: a redirect window's, or ones said to be external
  const external = redirect !== undefined || parameters.external === true;

  // a window can end more than one way (resolved, captured, closed) - only
  // the first counts
  let finished = false;
  const finishOnce: typeof finish = (value, exitCode) => {
    if (finished) return;
    finished = true;
    finish(value, exitCode);
  };

  const win = new BrowserWindow({
    parent,
    width: width ?? 900,
    height: height ?? 670,
    show: false,
    autoHideMenuBar: true,
    title: title ?? app,
    webPreferences: {
      // a third party's pages (a sign-in, say) get no window.cmdless
      preload: external ? undefined : preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  // ensure window always resolves
  win.on('closed', () => { finishOnce(null); });

  // navigating to the redirect prefix ends the window with that URL, before
  // it's ever requested - a provider's HTTP redirect is will-redirect, a
  // page's own navigation is will-navigate
  if (redirect) {
    const capture = (event: Electron.Event, url: string) => {
      if (!url.startsWith(redirect)) return;
      event.preventDefault();
      if (finished) return;
      // resolving can end the whole app (and the window with it), so the
      // window is only closed if it's still there afterwards
      finishOnce(url);
      if (!win.isDestroyed()) win.close();
    };
    win.webContents.on('will-redirect', capture);
    win.webContents.on('will-navigate', capture);
  }
  win.on('ready-to-show', () => win.show());

  // a title that was asked for stays, whatever the page calls itself
  if (title) win.on('page-title-updated', event => event.preventDefault());

  if (external) {
    // a sign-in's popups (say, "continue with Google") report back to the
    // page that opened them, so they open here as child windows rather
    // than in the default browser - with no preload either
    const userAgent = browserUserAgent();
    win.webContents.setUserAgent(userAgent);
    win.webContents.setWindowOpenHandler(() => ({
      action: 'allow',
      overrideBrowserWindowOptions: {
        parent: win,
        autoHideMenuBar: true,
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
      },
    }));
    win.webContents.on('did-create-window', child => child.webContents.setUserAgent(userAgent));
  } else {
    win.webContents.setWindowOpenHandler((details) => {
      shell.openExternal(details.url);
      return { action: 'deny' };
    });
  }

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  // a capture during the very first load aborts it, which isn't a failure
  try {
    if (type === 'url') await win.loadURL(source);
    else await win.loadFile(source);
  } catch (error) {
    if (!finished) throw error;
  }

  return win;
}

// this process is the host; each UIHost connected to it is served through
// one of these: its side of the connection, and (to come) the windows, dialogs
// and trays it opened, which go with it
class ServerHandle {
  readonly id = crypto.randomUUID();
  constructor(readonly server: UIServer, readonly owner: boolean) { }
}

// what a process that lost the lock hands the lock holder: where to send
// this host's address, once its owner has connected
type Forwarded = { reply: string };

// how long the owner gets to connect once it's been told where to
const OWNER_TIMEOUT_MS = 10_000;

async function main() {
  // without this, Ctrl+C leaves Electron's own default (uncontrolled)
  // teardown to tear down windows
  process.on('SIGINT', () => app.quit());
  process.on('SIGTERM', () => app.quit());

  // no Dock icon until a window or dialog is showing
  app.dock?.hide();

  // the app name is the single-instance lock, and names userData - a
  // throwaway (ephemeral) one under temp, which its owner cleans up
  const appName = resolveCmdlessApp();
  const ephemeral = isEphemeralCmdlessApp(appName);
  const userData = path.join(app.getPath(ephemeral ? 'temp' : 'appData'), appName);
  app.setName(appName);
  app.setPath('userData', userData);

  // losing the lock: the lock holder sends its address here once its own
  // owner has connected, and this process passes it on to its creator
  const reply = await listenOnce<HostService>();
  if (!app.requestSingleInstanceLock({ reply: reply.socketPath } satisfies Forwarded)) {
    try {
      await resolveService(await reply.message);
    } catch (error) {
      await rejectService(error).catch(() => { });
    }
    return app.quit();
  }
  reply.close();

  // everything that has to be set up before a host is answered
  const ready = (async () => {
    await app.whenReady();
    // Set app user model id for windows
    electronApp.setAppUserModelId('dev.cmdless.ui');
    // Default open or close DevTools by F12 in development
    // and ignore CommandOrControl + R in production.
    // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
    app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window));
    // the owner's connection decides when this ends, not its windows
    app.on('window-all-closed', () => { });
  })();

  const sdkVersion = await getCmdlessUIVersion();
  const servers = new Map<string, ServerHandle>();
  let ownerConnected!: () => void;
  const owned = new Promise<void>(resolve => ownerConnected = resolve);
  let hasOwner = false;

  const { accept } = await UIHost.protocol.defineHost({
    configure: server => {
      server.onRequest.init(async params => {
        await ready;
        // whoever got the lock first decides the version every later host
        // of this app gets
        if (params.sdkVersion !== sdkVersion)
          throw new Error(`${appName} is running @cmdless/ui-sdk ${sdkVersion}, not ${params.sdkVersion} - close it to use ${params.sdkVersion}`);

        // the first to connect is the owner: nothing else learns the
        // address until it has
        const owner = !hasOwner;
        hasOwner = true;
        const handle = new ServerHandle(server, owner);
        servers.set(handle.id, handle);
        server.onClose(() => {
          servers.delete(handle.id);
          if (owner) app.quit();
        });
        if (owner) ownerConnected();

        const result: InitializeResult = { appName, userData, ephemeral, sdkVersion, hasSingleInstanceLock: owner };
        return result;
      });
    },
  })();
  const address = getTmpSocketPath(`cmdless-ui-host-${crypto.randomUUID()}`);
  await startSocket({ accept, options: { path: address } });
  const service: HostService = { address };

  // a process that lost the lock gets the address only once the owner has
  // connected
  app.on('second-instance', async (_, __, ___, data: unknown) => {
    try {
      await owned;
      await sendTo((data as Forwarded).reply, { type: 'resolve', value: service });
    } catch (error) {
      console.error('ui-runtime: answering a second instance failed:', error);
    }
  });

  await ready;
  // the owner is told where to connect - and if it never does, nothing
  // would ever end this process, so it ends itself
  await resolveService(service);
  const ownerTimeout = setTimeout(() => app.quit(), OWNER_TIMEOUT_MS);
  void owned.then(() => clearTimeout(ownerTimeout));
}

void main().catch(async error => {
  console.error(error);
  await rejectService(error).catch(() => { });
  app.exit(1);
});
