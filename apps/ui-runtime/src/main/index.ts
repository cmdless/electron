import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, shell, BrowserWindow, dialog } from 'electron';
import { electronApp, optimizer } from '@electron-toolkit/utils';
import { Argument, Command } from 'commander';
import { cmdlessIPC, createElectronIPC, types } from '@cmdless/ui-sdk';
import { getEphemeralPrefix, getCmdlessApp, setCmdlessApp, CmdlessUI, binOutput, MessageSocketWaiter, BinChannel, runAsMcp } from '@cmdless/ui-sdk/node';
import type { BinResolve, BinCleanup, McpHandle } from '@cmdless/ui-sdk/node';
import { asElectronIPC } from '@cmdless/rpc-sdk';

// Electron's main-process 'ready' event only fires once this entry module
// finishes loading - top-level awaiting anything that itself (directly or
// transitively) waits on app.whenReady() deadlocks the whole app, since the
// module can never "finish" while it's still awaiting readiness.
// See https://github.com/electron/electron/issues/40719.
let send: (message: BinResolve | BinCleanup) => void;

// the default outer-most resolve which also produces an exit code
let resolved = false;
function resolve<T>(value: T, exitCode = 0) {
  if (resolved) return;
  resolved = true;
  const message: BinResolve = { type: 'resolve', value };
  send(message);
  app.exit(exitCode);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const preloadPath = path.join(__dirname, '../preload/index.mjs');

// ui-runtime is a generic host - it never runs an app's own createApp
// in-process (that lives in the app's own bin process, the one that invoked
// createShowCommand), so there's no "self" shortcut here: every request,
// including one from an app asking for its own tools, resolves the same
// way.
//
// Scoped per window tree, not global: a request walks up from the
// requesting window through its ancestors (Electron's own --parent chain,
// already wired through createWindow) looking for an existing instance for
// that package; if none exists anywhere up the chain, the requesting
// window opens one itself and owns it. Sibling windows under the same
// parent therefore share one instance by default (the parent is a common
// ancestor both find), but two unrelated top-level windows never do - and
// closing the window that owns an instance disposes it instead of letting
// it outlive its owner.
const mcpHandlesByWindow = new Map<number, Map<string, Promise<McpHandle>>>();

function findMcpHandle(win: BrowserWindow, key: string): Promise<McpHandle> | undefined {
  for (let current: BrowserWindow | null = win; current; current = current.getParentWindow()) {
    const handle = mcpHandlesByWindow.get(current.id)?.get(key);
    if (handle) return handle;
  }
  return undefined;
}

function getMcpAddress(win: BrowserWindow, packageName: string, version?: string): Promise<string> {
  const key = `${packageName}@${version ?? ''}`;
  const existing = findMcpHandle(win, key);
  if (existing) return existing.then(({ address }) => address);

  const handle = runAsMcp(import.meta, packageName, version);
  let owned = mcpHandlesByWindow.get(win.id);
  if (!owned) mcpHandlesByWindow.set(win.id, owned = new Map());
  owned.set(key, handle);
  handle.catch(() => owned.delete(key)); // don't cache a failed attempt

  return handle.then(({ address }) => address);
}

function disposeWindowMcpHandles(windowId: number) {
  const owned = mcpHandlesByWindow.get(windowId);
  if (!owned) return;
  mcpHandlesByWindow.delete(windowId);
  for (const handle of owned.values())
    handle.then(({ dispose }) => dispose()).catch(() => { });
}

// a safety net, not the primary cleanup path - every owner's handles are
// already disposed when its own window closes (see createWindow).
app.on('before-quit', () => {
  for (const windowId of [...mcpHandlesByWindow.keys()])
    disposeWindowMcpHandles(windowId);
});

async function createWindow(parameters: types.ShowParams, finish = resolve, parent?: BrowserWindow) {
  const { app, address, type, source, width, height } = parameters;

  const win = new BrowserWindow({
    parent,
    width: width ?? 900,
    height: height ?? 670,
    show: false,
    autoHideMenuBar: true,
    title: app,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  const ui = new CmdlessUI(parameters =>
    new Promise<string>((resolve, reject) => {
      try {
        handle(parameters, (value, exitCode = 0) => {
          if (exitCode !== 0) {
            reject(new Error(`UI command exited with code ${exitCode}`));
            return;
          }
          resolve(binOutput(value));
        }, win);
      } catch (error) {
        reject(error);
      }
    }));

  const ipc = cmdlessIPC.createServer(createElectronIPC(asElectronIPC(win.webContents.ipc, win.webContents)));
  ipc.onNotification.resolve(({ value, exitCode }) => finish(value, exitCode));
  ipc.onRequest.ui(parameters => ui.run(parameters));
  ipc.onRequest.connectionInfo(() => ({ address, windowId: win.id }));
  ipc.onRequest.mcpAddress(({ packageName, version }) =>
    getMcpAddress(win, packageName, version).then(address => ({ address })));
  ipc.listen();

  // ensure window always resolves
  win.on('closed', () => { finish(null); disposeWindowMcpHandles(win.id); });
  win.on('ready-to-show', () => win.show());

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: 'deny' };
  });

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (type === 'url') await win.loadURL(source);
  else await win.loadFile(source);

  return win;
}

function handle(parameters: types.Params, finish = resolve, parent?: BrowserWindow) {
  if (!parent && parameters.parent)
    parent = BrowserWindow.fromId(parameters.parent) ?? undefined;

  switch (parameters.kind) {
    case 'show':
      createWindow(parameters, finish, parent);
      break;
    case 'message-box':
      const messageBox = parent
        ? dialog.showMessageBox(parent, parameters)
        : dialog.showMessageBox(parameters);
      messageBox.then(finish);
      break;
    default: throw new Error(`Unsupported kind: ${JSON.stringify(parameters, null, 2)}`);
  }
}

async function run(parameters: types.Params, finish = resolve) {
  // --app <name> takes precedence, otherwise ephemeral
  const appName = parameters.app || getCmdlessApp() || `${getEphemeralPrefix()}${crypto.randomUUID()}`;
  parameters.app = appName;
  setCmdlessApp(appName);

  app.setName(appName);
  app.setPath('userData', path.join(app.getPath('appData'), appName));

  // userData above must be set first - this reports whatever it resolves
  // to, so it has to run after, not before.
  if (appName.startsWith(getEphemeralPrefix())) {
    const message: BinCleanup = { type: 'cleanup', appName, userData: app.getPath('userData') };
    send(message);
  }

  const waiter = new MessageSocketWaiter<{ value: any, exitCode: number }>().start();
  const additionalData = { ...parameters, id: waiter.id };

  // if userData is already in use, wait for the owning process to return the result
  if (!app.requestSingleInstanceLock(additionalData)) {
    return waiter.withResult(message => finish(message.value, message.exitCode));
  }

  // we own this instance; setup cleanup and stop the waiter
  waiter.stop();

  // forward parameters from external processes that end up with the same userData
  app.on('second-instance', (_, __, ___, data: unknown) => {
    const { id, ...parameters } = (data as typeof additionalData);
    const resolve = waiter.connect(id);
    handle(parameters, (value, exitCode = 0) => resolve({ value, exitCode }));
  });

  // This method will be called when Electron has finished
  // initialization and is ready to create browser windows.
  // Some APIs can only be used after this event occurs.
  await app.whenReady();

  // Set app user model id for windows
  electronApp.setAppUserModelId('dev.cmdless.ui');

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  app.on('window-all-closed', () => finish(null));

  handle(parameters, finish);
}

// CLI entry
function cli() {
  const program = new Command();

  program
    .command('show').description('Show content inside of an Electron browser window')
    .addArgument(new Argument('<type>', 'Source type to show in the window').choices(types.ShowTypes))
    .argument('<source>', 'File or URL to open in the window')
    .option('--app <name>', 'App name, used to group processes and parent windows and dialogs')
    .option('--parent <id>', 'ID of the Electron Browsser Window to use as the parent for the window', Number)
    .option('--width <number>', 'Width of the window', Number)
    .option('--height <number>', 'Height of the window', Number)
    .option('--address <address>', 'Backend address')
    .action((type, source, options: types.ShowOptions) => run({ kind: 'show', type, source, ...options }));

  program
    .command('message-box').description('Display a simple Electron message box')
    .addArgument(new Argument('<type>', 'Type of message').choices(types.MessageBoxTypes).default('none'))
    .argument('<message>', 'Message to display in the message box')
    .option('--app <name>', 'App name, used to group processes and parent windows and dialogs')
    .option('--parent <id>', 'ID of the Electron Browsser Window to use as the parent for the dialog', Number)
    .action((type, message, options: types.MessageBoxOptions) => run({ kind: 'message-box', type, message, ...options }));

  return program;
}

async function main() {
  send = await BinChannel.connect();

  // without this, Ctrl+C leaves Electron's own default (uncontrolled)
  // teardown to tear down windows - which can fire win 'closed' -> resolve()
  // -> send() *after* the channel's connection has already started closing.
  // `.on`, not `.once` (resolve() is itself idempotent) - see the comment on
  // forwardSignals in ui-sdk/node/utils.ts for why a single delivery can't
  // be assumed.
  process.on('SIGINT', () => resolve(null));
  process.on('SIGTERM', () => resolve(null));

  await cli().parseAsync();
}

void main().catch(error => {
  console.error(error);
  app.exit(1);
});