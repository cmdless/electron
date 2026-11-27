import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, clipboard, dialog, screen, shell, BrowserWindow, Menu, nativeImage, Notification, Tray } from 'electron';
import { BACKEND_ARG, cmdlessIPC, cmdlessViewIPC, createElectronIPC, createElectronViewIPC } from '@cmdless/ui-sdk';
import type { types, ViewProps } from '@cmdless/ui-sdk';
import { getCmdlessUIVersion, getTmpSocketPath, UIHost } from '@cmdless/ui-sdk/node';
import type {
  CardParams, CardUpdateParams, FormParams, ViewWindowParams, WindowConnectParams, WindowOptions,
  ConnectionMessage, DialogParams, HandleClosedParams, HandleParams, HostService, InitializeResult, NotificationParams, TrayEvent,
  TrayMenuItem, TrayParams, UIServer, WindowOpenParams,
} from '@cmdless/ui-sdk/node';
import { asElectronIPC } from '@cmdless/rpc-sdk';
import { startSocket } from '@cmdless/rpc-sdk/node';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const preloadPath = path.join(__dirname, '../preload/index.cjs');
// the host's own page, which shows a card or a form
const viewPath = path.join(__dirname, '../renderer/view.html');

// opens a link in the default browser or mail app - only those: Electron's
// shell.openExternal would also launch files and other apps' URL schemes
async function openLink(url: string) {
  const { protocol } = new URL(url);
  if (!['http:', 'https:', 'mailto:'].includes(protocol)) throw new Error(`won't open a ${protocol} link`);
  await shell.openExternal(url);
}

// a window, dialog or tray a connected UIHost opened. It belongs to that
// connection's ServerHandle, and goes when it does.
export abstract class UIHandle {
  readonly id = crypto.randomUUID();
  private disposed = false;

  constructor(readonly owner: ServerHandle) {
    owner.add(this);
  }

  // what anything opened from it opens in front of - nothing, unless it's a
  // window
  get parent(): BrowserWindow | undefined {
    return undefined;
  }

  // whether it's something the Dock icon is shown for - a window or a
  // dialog; a tray lives outside the Dock. A getter, so it's already right
  // while the base constructor adds it.
  get showsInDock() {
    return true;
  }

  // opens a window in front of this one, for the same UIHost
  openWindow(params: Omit<WindowOpenParams, 'parent'>) {
    return new WindowHandle(this.owner, params, this.parent);
  }

  // shows a dialog in front of this one, for the same UIHost
  openDialog(params: Omit<DialogParams, 'parent'>) {
    return new DialogHandle(this.owner, params, this.parent);
  }

  // opens a card window in front of this one, for the same UIHost
  openCard(params: Omit<CardParams, 'parent'>) {
    return new CardHandle(this.owner, params, this.parent);
  }

  // opens a form window in front of this one, for the same UIHost
  openForm(params: Omit<FormParams, 'parent'>) {
    return new FormHandle(this.owner, params, this.parent);
  }

  // ends it, whoever asked - its UIHost, its renderer, the person closing
  // it, or its connection going - telling its UIHost how it ended first
  dispose(value?: unknown, error?: string) {
    if (this.disposed) return;
    this.disposed = true;
    this.owner.remove(this, { id: this.id, value, error });
    this.close();
  }

  // what ending it means for this kind: closing the window, say
  protected abstract close(): void;

  // brings its window to the front, if it has one
  focus() {
    const win = this.parent;
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    bringUp(win);
    win.focus();
  }
}

// this process is the host; each UIHost connected to it is served through
// one of these: its side of the connection, and the windows, dialogs and
// trays it opened
export class ServerHandle {
  readonly id = crypto.randomUUID();
  readonly handles = new Map<string, UIHandle>();
  private connected = true;

  constructor(readonly server: UIServer, readonly isOwner: boolean, private readonly changed: () => void) {
    server.onClose(() => {
      this.connected = false;
      for (const handle of [...this.handles.values()]) handle.dispose();
    });
  }

  add(handle: UIHandle) {
    this.handles.set(handle.id, handle);
    this.changed();
  }

  remove(handle: UIHandle, closed: HandleClosedParams) {
    if (!this.handles.delete(handle.id)) return;
    if (this.connected) this.server.notify.handleClosed(closed);
    this.changed();
  }

  trayEvent(params: HandleParams & TrayEvent) {
    if (this.connected) this.server.notify.trayEvent(params);
  }

  cardEvent(params: HandleParams & types.CardEvent) {
    if (this.connected) this.server.notify.cardEvent(params);
  }

  // a message from another of the app's UIHosts
  message(params: ConnectionMessage) {
    if (!this.connected) throw new Error('that connection has gone');
    this.server.notify.connectionMessage(params);
  }

  // a window's page asking for its backend: its UIHost says where, with a
  // token for one connection
  windowConnect(params: WindowConnectParams) {
    if (!this.connected) throw new Error('the window\'s UIHost has gone');
    return this.server.request.windowConnect(params);
  }
}

// a handle's BrowserWindow, from what was asked of its look (WindowOptions)
// and the size that suits what it shows: it ends its handle when it's closed
// by hand (with no value), comes to the front once it has something to show
// (unless whoever made it shows it themselves), and keeps a title that was
// asked for whatever its page calls itself. A page gets the preload unless
// it's a third party's - with what it's told at start (argv) when it does.
function createWindow(
  handle: UIHandle,
  { width, height, title }: WindowOptions = {},
  defaults: { width: number; height: number },
  parent: BrowserWindow | undefined,
  preload: false | string[],
  showWhenReady = true,
) {
  const win = new BrowserWindow({
    parent,
    width: width ?? defaults.width,
    height: height ?? defaults.height,
    show: false,
    autoHideMenuBar: true,
    title: title ?? app.getName(),
    webPreferences: {
      preload: preload ? preloadPath : undefined,
      additionalArguments: preload || undefined,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.on('closed', () => handle.dispose());
  if (showWhenReady) win.on('ready-to-show', () => bringUp(win));
  if (title) win.on('page-title-updated', event => event.preventDefault());
  return win;
}

// shows a window in front - with no Dock icon until now, the app isn't the
// active one, and without this the window opens behind whatever is
function bringUp(win: BrowserWindow) {
  app.focus({ steal: true });
  win.show();
}

// the tallest a window that fits its content gets: most of the screen it's
// on, past which its page scrolls - and the shortest
const FIT_SCREEN_SHARE = 0.8;
const FIT_MIN_HEIGHT = 120;

// Electron's user agent with its own tokens (Electron/x, the app's
// name/version) taken out, leaving what Chrome sends - some sign-in pages,
// Google's among them, refuse a browser they see is embedded in an app
function browserUserAgent() {
  return app.userAgentFallback.replace(/ (?!Mozilla|AppleWebKit|Chrome|Safari)[\w.-]+\/[\w.-]+/g, '');
}

export class WindowHandle extends UIHandle {
  readonly window: BrowserWindow;

  constructor(owner: ServerHandle, parameters: Omit<WindowOpenParams, 'parent'>, parent?: BrowserWindow) {
    super(owner);
    const { type, source, redirect, window, backend } = parameters;
    // a third party's pages: a redirect window's, or ones said to be external
    const external = redirect !== undefined || parameters.external === true;

    // a third party's pages (a sign-in, say) get no window.cmdless; the
    // preload hears whether there's a backend for it to connect to
    const preload = external ? false : backend ? [BACKEND_ARG] : [];
    const win = this.window = createWindow(this, window, { width: 900, height: 670 }, parent, preload);

    // navigating to the redirect prefix ends the window with that URL, before
    // it's ever requested - a provider's HTTP redirect is will-redirect, a
    // page's own navigation is will-navigate
    if (redirect) {
      const capture = (event: Electron.Event, url: string) => {
        if (!url.startsWith(redirect)) return;
        event.preventDefault();
        this.dispose(url);
      };
      win.webContents.on('will-redirect', capture);
      win.webContents.on('will-navigate', capture);
    }

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
      // the window's preload: it can resolve the window, and ask for its
      // backend - which only the window's own UIHost can give it, and only
      // this window can ask for (this IPC is the window's own)
      const ipc = cmdlessIPC.createServer(createElectronIPC(asElectronIPC(win.webContents.ipc, win.webContents)));
      ipc.onNotification.resolve(({ value, exitCode = 0 }) =>
        exitCode === 0 ? this.dispose(value) : this.dispose(undefined, `the window exited with code ${exitCode}`));
      ipc.onRequest.connect(() => {
        if (!backend) throw new Error('this window was opened without a backend');
        return owner.windowConnect({ backend });
      });
      ipc.listen();
    }

    // a page that won't load ends the window with why - unless it's already
    // ended (a capture during the very first load aborts it)
    const load = type === 'url' ? win.loadURL(source) : loadFileWithHash(win, source);
    load.catch(error => this.dispose(undefined, String(error)));
  }

  override get parent() {
    return this.window;
  }

  protected close() {
    if (!this.window.isDestroyed()) this.window.close();
  }
}

// a window showing the host's own page - a card or a form - rather than one
// of a UIHost's. The page asks what to show, and nothing it shows can take
// it anywhere else: links open in the browser, and it never navigates.
abstract class ViewHandle extends UIHandle {
  readonly window: BrowserWindow;
  protected readonly view: ReturnType<typeof cmdlessViewIPC.createServer>;

  constructor(owner: ServerHandle, props: ViewProps, { window }: Omit<ViewWindowParams, 'parent'>, parent?: BrowserWindow) {
    super(owner);
    // a view fits its window's height to what it shows, unless a height was
    // asked for - shown once it's sized, so it never jumps - and stops once
    // the window's been resized by hand
    let fitting = window?.height === undefined;
    const win = this.window = createWindow(this, window, { width: 520, height: 640 }, parent, [], !fitting);
    win.on('will-resize', () => { fitting = false; });

    win.webContents.setWindowOpenHandler(({ url }) => {
      openLink(url).catch(() => { });
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', event => event.preventDefault());

    const view = this.view = cmdlessViewIPC.createServer(createElectronViewIPC(asElectronIPC(win.webContents.ipc, win.webContents)));
    view.onRequest.props(() => props);
    view.onNotification.close(({ value }) => this.dispose(value));
    view.onNotification.resize(({ height }) => {
      if (!fitting || win.isDestroyed()) return;
      const [width] = win.getContentSize();
      const { workArea } = screen.getDisplayMatching(win.getBounds());
      const fitted = Math.max(FIT_MIN_HEIGHT, Math.min(Math.ceil(height), Math.floor(workArea.height * FIT_SCREEN_SHARE)));
      win.setContentSize(width, fitted);
      if (!win.isVisible()) {
        win.center();
        bringUp(win);
      }
    });
    this.listen(view);
    view.listen();

    win.loadFile(viewPath).catch(error => this.dispose(undefined, String(error)));
  }

  // what else this kind hears from its page
  protected listen(_view: ReturnType<typeof cmdlessViewIPC.createServer>) { }

  override get parent() {
    return this.window;
  }

  protected close() {
    if (!this.window.isDestroyed()) this.window.close();
  }
}

// an Adaptive Card in a window: it ends with the Action.Submit chosen on it
// (or nothing, closed by hand), reporting each Action.Execute until then -
// and can be shown another card
export class CardHandle extends ViewHandle {
  constructor(owner: ServerHandle, { card, hostConfig, window }: Omit<CardParams, 'parent'>, parent?: BrowserWindow) {
    super(owner, { view: 'card', card, hostConfig }, { window }, parent);
  }

  protected override listen(view: ReturnType<typeof cmdlessViewIPC.createServer>) {
    view.onNotification.event(event => this.owner.cardEvent({ id: this.id, ...event }));
  }

  update({ card }: Omit<CardUpdateParams, 'id'>) {
    this.view.notify.update({ card });
  }
}

// a form in a window, ending with what it was submitted with
export class FormHandle extends ViewHandle {
  constructor(owner: ServerHandle, { schema, uiSchema, formData, submitText, window }: Omit<FormParams, 'parent'>, parent?: BrowserWindow) {
    super(owner, { view: 'form', schema, uiSchema, formData, submitText }, { window }, parent);
  }
}

// a file, with any #hash or ?search after its path kept as that rather than
// taken as part of the file's name - a page with a hash router, say
function loadFileWithHash(win: BrowserWindow, source: string) {
  const match = /^([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(source)!;
  return win.loadFile(match[1], { search: match[2], hash: match[3] });
}

// a message box, ending with the button that was chosen. Closing it any
// other way - its UIHost, or its connection going - dismisses it.
// On macOS a message box with no window to sit on is app-modal, as any
// native alert is: only the user can end it - code can't dismiss it, and
// the app can't quit until it's answered (see whenNoneModal). One opened
// from a window is a sheet on it, and can be dismissed.
export class DialogHandle extends UIHandle {
  // the app-modal message boxes showing, and what's waiting on there being
  // none
  private static modal = 0;
  private static waiting: (() => void)[] = [];

  // settles once no app-modal message box is showing
  static whenNoneModal() {
    if (DialogHandle.modal === 0) return Promise.resolve();
    return new Promise<void>(resolve => DialogHandle.waiting.push(resolve));
  }

  private readonly dismissed = new AbortController();
  private readonly modal: boolean;

  constructor(owner: ServerHandle, params: Omit<DialogParams, 'parent'>, parent?: BrowserWindow) {
    super(owner);
    const { type, message, detail, buttons, defaultId, cancelId, checkboxLabel, checkboxChecked } = params;
    const options = { type, message, detail, buttons, defaultId, cancelId, checkboxLabel, checkboxChecked, signal: this.dismissed.signal };
    // with no Dock icon until now, the app isn't the active one - without
    // this, a dialog with no window to sit on opens behind whatever is
    if (!parent) app.focus({ steal: true });
    const shown = parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
    this.modal = process.platform === 'darwin' && !parent;
    if (this.modal) {
      DialogHandle.modal++;
      void shown.catch(() => { }).finally(() => {
        if (--DialogHandle.modal > 0) return;
        for (const resolve of DialogHandle.waiting.splice(0)) resolve();
      });
    }
    shown.then(
      ({ response, checkboxChecked }) => this.dispose({ response, checkboxChecked }),
      error => this.dispose(undefined, String(error)),
    );
  }

  // an app-modal one can't be dismissed - it stays until it's answered
  protected close() {
    if (!this.modal) this.dismissed.abort();
  }
}

// an icon in the tray (the menu bar, on macOS), with a menu. It stays until
// it's closed, reporting clicks to its UIHost as it goes.
export class TrayHandle extends UIHandle {
  readonly tray: Tray;

  constructor(owner: ServerHandle, params: TrayParams) {
    // a tray can't be made without an image, so nothing is added for one
    // that won't load
    const image = trayImage(params.icon);
    super(owner);
    this.tray = new Tray(image);
    this.tray.on('click', () => owner.trayEvent({ id: this.id, event: 'click' }));
    this.update({ ...params, icon: undefined });
  }

  // changes what was given, and leaves the rest
  update({ icon, tooltip, title, menu }: Partial<TrayParams>) {
    if (icon !== undefined) this.tray.setImage(trayImage(icon));
    if (tooltip !== undefined) this.tray.setToolTip(tooltip);
    if (title !== undefined) this.tray.setTitle(title);
    if (menu !== undefined) this.tray.setContextMenu(this.buildMenu(menu));
  }

  private buildMenu(menu: TrayMenuItem[]): Menu {
    return Menu.buildFromTemplate(menu.map(item => {
      switch (item.type) {
        case 'separator': return { type: 'separator' as const };
        case 'submenu': return { label: item.label, enabled: item.enabled, submenu: this.buildMenu(item.submenu) };
        default: return {
          type: item.type ?? 'normal', label: item.label, checked: item.checked, enabled: item.enabled,
          click: () => this.owner.trayEvent({ id: this.id, event: 'menu-item', item: item.id }),
        };
      }
    }));
  }

  override get showsInDock() {
    return false;
  }

  protected close() {
    if (!this.tray.isDestroyed()) this.tray.destroy();
  }
}

// an OS notification: it ends with 'click' when it's clicked, or nothing when
// it's dismissed. It lives outside the Dock, like a tray.
export class NotificationHandle extends UIHandle {
  readonly notification: Notification;

  constructor(owner: ServerHandle, params: NotificationParams) {
    if (!Notification.isSupported()) throw new Error('notifications aren\'t supported here');
    super(owner);
    const notification = this.notification = new Notification({ title: params.title, body: params.body });
    notification.on('click', () => this.dispose('click'));
    notification.on('close', () => this.dispose());
    // macOS refuses, say, an app whose signature it doesn't trust - without
    // this, the notification would just never appear
    notification.on('failed', (_, error) => this.dispose(undefined, `the notification couldn't be shown: ${error}`));
    notification.show();
  }

  override get showsInDock() {
    return false;
  }

  protected close() {
    this.notification.close();
  }
}

// the icon a tray gets when it's given none (an empty string)
const DEFAULT_TRAY_ICON = fileURLToPath(new URL('../../resources/trayTemplate.png', import.meta.url));

function trayImage(icon: string) {
  const image = nativeImage.createFromPath(icon || DEFAULT_TRAY_ICON);
  if (image.isEmpty()) throw new Error(`no image at ${icon}`);
  return image;
}

// what the host reports to every UIHost about itself
export type HostInfo = Omit<InitializeResult, 'hasSingleInstanceLock' | 'sdkVersion' | 'connectionId'>;

// the host: where it listens, and every UIHost connected to it. The first to
// connect is its owner - nothing else is told the address until it has, and
// has set itself up.
export class Host {
  readonly servers = new Map<string, ServerHandle>();
  // settles once the owner has connected (initialized), once it has set
  // itself up too (ready) - what anything else waits on to join - and once
  // it has gone, set up or not
  readonly connected: Promise<ServerHandle>;
  readonly owned: Promise<ServerHandle>;
  readonly ownerClosed: Promise<void>;
  private readonly handlesListeners = new Set<(count: number) => void>();

  private constructor(readonly service: HostService, connected: Promise<ServerHandle>, owned: Promise<ServerHandle>) {
    this.connected = connected;
    this.owned = owned;
    this.ownerClosed = connected.then(owner => new Promise<void>(resolve => owner.server.onClose(resolve)));
  }

  // how many windows and dialogs are open, across every UIHost - what the
  // Dock icon is shown for (trays aren't)
  get shownCount() {
    let count = 0;
    for (const server of this.servers.values())
      for (const handle of server.handles.values()) if (handle.showsInDock) count++;
    return count;
  }

  // whether any UIHost has a tray up - what the app goes on for once its
  // windows are closed
  get hasTray() {
    for (const server of this.servers.values())
      for (const handle of server.handles.values()) if (handle instanceof TrayHandle) return true;
    return false;
  }

  // closes every window and dialog, across every UIHost - each told it's
  // closed, as if the person had closed it
  closeShown() {
    for (const server of [...this.servers.values()])
      for (const handle of [...server.handles.values()]) if (handle.showsInDock) handle.dispose();
  }

  onHandlesChanged(listener: (count: number) => void) {
    this.handlesListeners.add(listener);
    return { dispose: () => { this.handlesListeners.delete(listener); } };
  }

  private handlesChanged() {
    const count = this.shownCount;
    for (const listener of [...this.handlesListeners]) listener(count);
  }

  // listens on a fresh local address and serves UIHosts there. `ready` is
  // whatever has to be done before a UIHost is answered (Electron's own
  // readiness, for one) - connecting doesn't wait on it, initializing does.
  static async start(info: HostInfo, ready: Promise<void>) {
    const sdkVersion = await getCmdlessUIVersion();
    let ownerConnected!: (owner: ServerHandle) => void;
    const connected = new Promise<ServerHandle>(resolve => ownerConnected = resolve);
    let ownerReady!: (owner: ServerHandle) => void;
    const owned = new Promise<ServerHandle>(resolve => ownerReady = resolve);
    let hasOwner = false;

    const address = getTmpSocketPath(`cmdless-ui-host-${crypto.randomUUID()}`);
    const host = new Host({ address }, connected, owned);

    const { accept } = await UIHost.protocol.defineHost({
      configure: server => {
        // set once it has initialized; nothing else is served before then
        let handle: ServerHandle | undefined;
        const initialized = () => {
          if (!handle) throw new Error('initialize first');
          return handle;
        };

        server.onRequest.init(async params => {
          await ready;
          if (handle) throw new Error('already initialized');
          // whoever got the lock first decides the version every later
          // UIHost of this app gets
          if (params.sdkVersion !== sdkVersion)
            throw new Error(`${info.appName} is running @cmdless/ui-sdk ${sdkVersion}, not ${params.sdkVersion} - close it to use ${params.sdkVersion}`);

          const owner = !hasOwner;
          hasOwner = true;
          const current = handle = new ServerHandle(server, owner, () => host.handlesChanged());
          host.servers.set(current.id, current);
          server.onClose(() => host.servers.delete(current.id));
          if (owner) ownerConnected(current);

          const result: InitializeResult = { ...info, sdkVersion, hasSingleInstanceLock: owner, connectionId: current.id };
          return result;
        });

        // what something opened from another of this UIHost's handles opens
        // in front of
        const opener = (parent?: string) => {
          if (parent === undefined) return undefined;
          const from = initialized().handles.get(parent);
          if (!from) throw new Error(`no handle ${parent}`);
          return from;
        };

        server.onRequest.windowOpen(({ parent, ...params }) => {
          const from = opener(parent);
          return { id: (from ? from.openWindow(params) : new WindowHandle(initialized(), params)).id };
        });

        server.onRequest.dialogOpen(({ parent, ...params }) => {
          const from = opener(parent);
          return { id: (from ? from.openDialog(params) : new DialogHandle(initialized(), params)).id };
        });

        server.onRequest.cardOpen(({ parent, ...params }) => {
          const from = opener(parent);
          return { id: (from ? from.openCard(params) : new CardHandle(initialized(), params)).id };
        });

        server.onRequest.cardUpdate(({ id, card }) => {
          const found = initialized().handles.get(id);
          if (!(found instanceof CardHandle)) throw new Error(`no card ${id}`);
          found.update({ card });
        });

        server.onRequest.formOpen(({ parent, ...params }) => {
          const from = opener(parent);
          return { id: (from ? from.openForm(params) : new FormHandle(initialized(), params)).id };
        });

        server.onRequest.trayCreate(params => ({ id: new TrayHandle(initialized(), params).id }));

        server.onRequest.notificationShow(params => ({ id: new NotificationHandle(initialized(), params).id }));

        server.onRequest.trayUpdate(({ id, ...params }) => {
          const found = initialized().handles.get(id);
          if (!(found instanceof TrayHandle)) throw new Error(`no tray ${id}`);
          found.update(params);
        });

        server.onRequest.shellOpenExternal(async ({ url }) => {
          initialized();
          await openLink(url);
        });

        server.onRequest.clipboardWriteText(({ text }) => {
          initialized();
          clipboard.writeText(text);
        });

        server.onRequest.handleClose(({ id, value }) => {
          const found = initialized().handles.get(id);
          if (!found) throw new Error(`no handle ${id}`);
          found.dispose(value);
        });

        // the owner has set itself up: only now can anything else join
        server.onRequest.ready(() => {
          const current = initialized();
          if (current.isOwner) ownerReady(current);
        });

        server.onRequest.connections(() => {
          initialized();
          return [...host.servers.values()].map(({ id, isOwner }) => ({ id, owner: isOwner }));
        });

        // passed on to the connection it's for - the owner's, if it names
        // none
        server.onRequest.connectionSend(({ to, message }) => {
          const from = initialized();
          const target = to === undefined
            ? [...host.servers.values()].find(each => each.isOwner)
            : host.servers.get(to);
          if (!target) throw new Error(to === undefined ? 'the host has no owner' : `no connection ${to}`);
          target.message({ from: from.id, message });
        });

        server.onRequest.handleFocus(({ id }) => {
          const found = initialized().handles.get(id);
          if (!found) throw new Error(`no handle ${id}`);
          found.focus();
        });
      },
    })();
    await startSocket({ accept, options: { path: address } });
    return host;
  }
}
