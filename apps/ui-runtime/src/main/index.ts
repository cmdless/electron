import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, shell, BrowserWindow, dialog } from 'electron';
import { electronApp, optimizer } from '@electron-toolkit/utils';
import { Argument, Command } from 'commander';
import { cmdlessProtocol, createElectronIPC, types } from '@cmdless/ui-sdk';
import { getEphemeralPrefix, CmdlessEnv, CmdlessUI, binOutput } from '@cmdless/ui-sdk/node';
import type { BinResolve, BinCleanup } from '@cmdless/ui-sdk/node';
import { asElectronIPC } from '@cmdless/rpc-sdk';

// the default outer-most resolve which also produces an exit code
if (!process.send) throw new Error('main entry must be launched with an ipc channel');
let resolved = false;
function resolve<T>(value: T, exitCode = 0) {
  if (resolved) return;
  resolved = true;
  const message: BinResolve = { type: 'resolve', value };
  process.send?.(message, e => app.exit(e ? 1 : exitCode));
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const preloadPath = path.join(__dirname, '../preload/index.mjs');

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

  const ipc = cmdlessProtocol.createServer(createElectronIPC(asElectronIPC(win.webContents.ipc, win.webContents)));
  ipc.onNotification.resolve(({ value, exitCode }) => finish(value, exitCode));
  ipc.onRequest.ui(parameters => ui.run(parameters));

  if (address) {
    const token = CmdlessEnv.token;
    // establish connection once
  }

  // ensure window always resolves
  win.on('closed', () => finish(null));
  win.on('ready-to-show', () => {
    ipc.listen();
    win.show();
  });

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
  const appName = parameters.app || `${getEphemeralPrefix()}${crypto.randomUUID()}`;

  parameters.app = appName;

  app.setName(appName);
  app.setPath('userData', path.join(app.getPath('appData'), appName));

  if (appName.startsWith(getEphemeralPrefix())) {
    const message: BinCleanup = { type: 'cleanup', appName, userData: app.getPath('userData') };
    process.send?.(message);
  }

  // ephemeral is unique so, might as well always run this to acquire named app lock
  if (!app.requestSingleInstanceLock()) {
    finish(null, 1);
    return;
  }

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
    .option('--width <number>', 'Width of the window', Number)
    .option('--height <number>', 'Height of the window', Number)
    .option('--address <address>', 'Backend address')
    .action((type, source, options: types.ShowOptions) => run({ kind: 'show', type, source, ...options }));

  program
    .command('message-box').description('Display a simple Electron message box')
    .addArgument(new Argument('<type>', 'Type of message').choices(types.MessageBoxTypes).default('none'))
    .argument('<message>', 'Message to display in the message box')
    .option('--app <name>', 'App name, used to group processes and parent windows and dialogs')
    .action((type, message, options: types.MessageBoxOptions) => run({ kind: 'message-box', type, message, ...options }));

  return program;
}

await cli().parseAsync();