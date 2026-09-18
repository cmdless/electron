import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron';
import { electronApp, optimizer } from '@electron-toolkit/utils';
import { Argument, Command, Option } from 'commander';
import * as types from '@cmdless/ui-sdk/shared';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const preloadPath = path.join(__dirname, '../preload/index.mjs');

async function createWindow({ type, source, width, height }: types.ShowParams, finish = resolve) {
  const win = new BrowserWindow({
    width,
    height,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  //TODO: global handlers for cmdless preload
  ipcMain.on('ping', () => console.log('pong'));

  // ensure window always resolves
  win.on('closed', () => finish({}, 1));
  win.webContents.ipc.on('cmdless:resolve', (_, result, exitCode) => {
    finish(result, exitCode);
  });

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

function setup(parameters: types.SetupParams, factory: () => void) {
  // Set app user model id for windows
  electronApp.setAppUserModelId('dev.cmdless.ui');

  if (parameters.address && parameters.token) {
    // establish connection once
  }

  factory();
}

function setupWindow(parameters: types.ShowParams, finish = resolve) {
  const factory = () => createWindow(parameters, finish);

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) factory();
  });

  setup(parameters, factory);
}

let resolved = false;
function resolve<T>(value: T, exitCode = 0) {
  if (resolved) return;
  resolved = true;
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  process.stdout.write(serialized, e => app.exit(e ? 1 : exitCode));
}

function handle(parameters: types.Params, finish = resolve) {
  if (parameters.address)
    parameters.token = process.env.CMDLESS_TOKEN;
  switch (parameters.kind) {
    case 'show':
      setupWindow(parameters, finish);
      break;
    case 'message-box':
      setup(parameters, () => dialog.showMessageBox(parameters).then(finish));
      break;
    default: throw new Error(`Unsupported kind: ${JSON.stringify(parameters, null, 2)}`);
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
const whenReady = app.whenReady();

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// CLI entry
function cli() {
  const program = new Command();

  program
    .command('show').description('Show content inside of an Electron browser window')
    .addArgument(new Argument('<type>', 'Source type to show in the window').choices(types.ShowTypes))
    .argument('<source>', 'File or URL to open in the window')
    .option('--width <number>', 'Width of the window', Number, 900)
    .option('--height <number>', 'Height of the window', Number, 670)
    .option('--address <address>', 'Backend address')
    .action((type, source, options: types.ShowOptions) => handle({ kind: 'show', type, source, ...options }));

  program
    .command('message-box').description('Display a simple message box')
    .argument('<message>', 'Message to display in the message box')
    .addOption(new Option('--type <type>', 'Type of message ').choices(types.MessageBoxTypes).default('none'))
    .option('--address <address>', 'Backend address')
    .action((message, options: types.MessageBoxOptions) => handle({ kind: 'message-box', message, ...options }));

  return program;
}

await whenReady;
await cli().parseAsync();