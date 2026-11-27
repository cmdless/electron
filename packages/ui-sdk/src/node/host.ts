import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { defineProtocol } from '@cmdless/rpc-sdk';
import type { RpcProtocol } from '@cmdless/rpc-sdk';
import { connectSocket } from '@cmdless/rpc-sdk/node';
import { createWebSocket } from '@cmdless/rpc-sdk/ws';
import { closeWebSocketServer, getWebSocketUrl, waitForWebSocketListening } from '@cmdless/rpc-sdk/ws/node';
import { resolvePackageBin, waitForService } from '@cmdless/core/node';
import { getCmdlessUIVersion, setCmdlessApp } from './utils.js';
import { elicitationCard, elicitationResult, permissionCard, permissionResult } from '../prompts.js';
import type { ElicitationRequest, PermissionRequest } from '../prompts.js';
import type { CardEvent, CardView, FormView, MessageBoxType, ShowType } from '../types.js';

// what a host hands back to whoever connects to it: what it reports through
// resolveService, to its own creator or (for one that lost the lock) a
// creator the lock holder answers instead
export type HostService = { address: string };

export type InitializeParams = {
  sdkVersion: string;
};

export type InitializeResult = {
  appName: string;
  userData: string;
  ephemeral: boolean;
  sdkVersion: string;
  // whether this connection owns the host: the one whose creator started the
  // process that got the app's lock. The host lives as long as it does.
  hasSingleInstanceLock: boolean;
  // this connection's id, which other UIHosts of the app send to
  connectionId: string;
};

// how a window looks on the desktop - what goes to Electron's BrowserWindow.
// Left out, a size that suits what it shows, and the app's name as its title.
export type WindowOptions = {
  width?: number;
  height?: number;
  // the window's title, kept whatever its page calls itself
  title?: string;
};

// a window to open: what to show in it, how its window looks, and (by its
// handle's id) what it opens in front of
export type WindowParams = {
  type: ShowType;
  // the file or URL to show
  source: string;
  // a URL prefix: when the window is about to navigate to a URL starting
  // with it, the navigation is cancelled and the window ends with that URL -
  // for an OAuth redirect, say. Such a window shows a third party's pages, so
  // it gets no preload (no window.cmdless).
  redirect?: string;
  // the window shows a third party's pages without capturing a redirect - a
  // sign-in that finishes on its own, say - so it's treated like a redirect
  // window: no preload, a browser's user agent, popups as child windows
  external?: boolean;
  window?: WindowOptions;
  parent?: string;
  // serves the page's connect(): each connection it makes to this process
  // (once per load) is handed to this. Never sent to the host - it only
  // hears that there is one.
  backend?: WindowBackend;
};

// a window to open, as the host hears of it: its backend is only a key - the
// UIHost's name for it, which the host asks for it by when the page connects
export type WindowOpenParams = Omit<WindowParams, 'backend'> & { backend?: string };

// a message box to show, and (by its handle's id) what it shows in front of
export type DialogParams = {
  type: MessageBoxType;
  message: string;
  // smaller text under the message
  detail?: string;
  // the buttons to choose from, in order - left out, just OK
  buttons?: string[];
  // which button Enter chooses, and which Escape (or closing it) does
  defaultId?: number;
  cancelId?: number;
  // a checkbox under the message, and whether it starts ticked - whether it
  // ended ticked comes back with the button chosen
  checkboxLabel?: string;
  checkboxChecked?: boolean;
  parent?: string;
};

// what a dialog ends with: the button that was chosen, and whether its
// checkbox was ticked
export type DialogResult = { response: number; checkboxChecked: boolean };

// an item of a tray's menu: its id is what's reported when it's clicked. A
// radio item is checked alone among the radio items next to it; a submenu
// opens more items.
export type TrayMenuItem =
  | { type?: 'normal' | 'checkbox' | 'radio'; id: string; label: string; checked?: boolean; enabled?: boolean }
  | { type: 'submenu'; label: string; enabled?: boolean; submenu: TrayMenuItem[] }
  | { type: 'separator' };

// a tray icon: the image to show (a file; on macOS, a name ending in
// "Template" makes it follow the menu bar's colors - or an empty string for
// the runtime's own), and its menu
export type TrayParams = {
  icon: string;
  tooltip?: string;
  // shown beside the icon in the macOS menu bar
  title?: string;
  menu?: TrayMenuItem[];
};

// how a card or form window looks, and (by its handle's id) what it opens
// in front of
export type ViewWindowParams = { window?: WindowOptions; parent?: string };

// a window showing an Adaptive Card: it ends with the Action.Submit chosen
// on it, reporting each Action.Execute as card/event until then
export type CardParams = ViewWindowParams & CardView;

// a card to show instead of the one a card window has: inputs with the same
// id keep what was typed into them
export type CardUpdateParams = HandleParams & Pick<CardView, 'card'>;

// a window showing a form, ending with the data it was submitted with - or
// nothing, if it was cancelled
export type FormParams = ViewWindowParams & FormView;

// an OS notification to show
export type NotificationParams = { title: string; body?: string };

// what can change about a tray while it's up - anything left out stays
export type TrayUpdateParams = HandleParams & Partial<TrayParams>;

// something happened to a tray: it was clicked, or one of its menu's items was
export type TrayEvent = { event: 'click' } | { event: 'menu-item'; item: string };

// a link to open in the default browser (or mail app, for mailto:)
export type OpenExternalParams = { url: string };

// text to put on the clipboard
export type ClipboardWriteParams = { text: string };

// a window, dialog or tray this UIHost opened
export type HandleParams = { id: string };

// a window's page wants its backend, by the key the window was opened with:
// the window's UIHost answers with where to connect and a token good for one
// connection
export type WindowConnectParams = { backend: string };
export type WindowConnectResult = { url: string; token: string };

// ends a handle, with the value it ends with
export type HandleCloseParams = HandleParams & { value?: unknown };

// a handle has ended: its value (a window's resolve, a redirect it caught),
// or why it failed (a page that wouldn't load, say). Closing a window by
// hand ends it with no value.
export type HandleClosedParams = HandleParams & { value?: unknown; error?: string };

// a UIHost connected to the host - one per process that created or joined
// it - and whether it's the owner
export type ConnectionInfo = { id: string; owner: boolean };

// a message for another of the app's UIHosts, by its connection id - the
// owner's, if to is left out. Anything JSON can carry.
export type SendParams = { to?: string; message: unknown };

// a message from another of the app's UIHosts, and which one it's from
export type ConnectionMessage = { from: string; message: unknown };

const uiHostProtocol = defineProtocol(({ side, request, notification }) => ({
  clientToServer: side({
    requests: {
      init: request<InitializeParams, InitializeResult>('init'),
      windowOpen: request<WindowOpenParams, HandleParams>('window/open'),
      dialogOpen: request<DialogParams, HandleParams>('dialog/open'),
      trayCreate: request<TrayParams, HandleParams>('tray/create'),
      trayUpdate: request<TrayUpdateParams>('tray/update'),
      handleClose: request<HandleCloseParams>('handle/close'),
      handleFocus: request<HandleParams>('handle/focus'),
      shellOpenExternal: request<OpenExternalParams>('shell/openExternal'),
      clipboardWriteText: request<ClipboardWriteParams>('clipboard/writeText'),
      notificationShow: request<NotificationParams, HandleParams>('notification/show'),
      cardOpen: request<CardParams, HandleParams>('card/open'),
      cardUpdate: request<CardUpdateParams>('card/update'),
      formOpen: request<FormParams, HandleParams>('form/open'),
      connections: request<void, ConnectionInfo[]>('connections'),
      connectionSend: request<SendParams>('connection/send'),
      // this UIHost has finished setting itself up (CreateHostOptions'
      // initialize) - for the owner, what other UIHosts wait on to join
      ready: request<void>('ready'),
    },
  }),
  serverToClient: side({
    notifications: {
      handleClosed: notification<HandleClosedParams>('handle/closed'),
      trayEvent: notification<HandleParams & TrayEvent>('tray/event'),
      cardEvent: notification<HandleParams & CardEvent>('card/event'),
      connectionMessage: notification<ConnectionMessage>('connection/message'),
    },
    requests: {
      windowConnect: request<WindowConnectParams, WindowConnectResult>('window/connect'),
    },
  }),
}));

export type UIServer = ReturnType<typeof UIHost.protocol.createServer>;
export type UIClient = ReturnType<typeof uiHostProtocol.createClient>;

export type CreateHostOptions = {
  // the app's name, which is Electron's single-instance lock: a host with
  // the same name is joined rather than started. Left out, the host is a
  // throwaway one of this caller's own.
  app?: string;
  cmdlessRoot?: string;
  // how long the host gets to start and report where it is
  timeoutMs?: number;
  // sets the UIHost up before anything else can reach it: for the owner, no
  // other UIHost joins - and so none can send it a message - until this has
  // settled. Where onMessage, a tray and the like go. If it throws, create
  // does, and leaves the host.
  initialize?: (host: UIHost) => void | Promise<void>;
};

// what serves a window's page: called with each connection the page makes
// (once per load), it hands back the peer that answers it, which is then
// listened on - a protocol's accept(configure), or a host's own accept to
// share one across windows
export type WindowBackend = (connection: Parameters<RpcProtocol['createServer']>[0]) => { listen(): void };

// how long an end that arrived ahead of its handle's open is kept
const UNCLAIMED_MS = 60_000;

// how a remote handle is ended - by its UIHost, which hears it
const end = Symbol('end');

// what something can be opened from: a UIHost, on its own, or a handle, in
// front of it. A factory opens through one, and reaches the host itself (its
// shell, its clipboard) through .host.
export interface UIOpener {
  readonly host: UIHost;
  openWindow<W = unknown>(params: Omit<WindowParams, 'parent'>): Promise<RemoteWindow<W>>;
  openDialog(params: Omit<DialogParams, 'parent'>): Promise<RemoteDialog>;
  openCard(params: Omit<CardParams, 'parent'>): Promise<RemoteCard>;
  openForm<F = unknown>(params: Omit<FormParams, 'parent'>): Promise<RemoteForm<F>>;
  open<P, H extends RemoteHandle<any>>(factory: UIFactory<P, H>, params: P): Promise<H>;
}

// something to open, typed by its own params: a window and the backend that
// serves it, say - opened in whoever's process calls it, from whatever it's
// given to open from. Define one with UIHost.factory.
export type UIFactory<P, H extends RemoteHandle<any>> = (opener: UIOpener, params: P) => Promise<H>;

// a window, dialog or tray a UIHost has opened on its host
export abstract class RemoteHandle<T = unknown> implements UIOpener {
  // the value it ends with: a window's resolve, the redirect it caught, or
  // nothing if it was closed by hand. Rejects if it failed, or the host went.
  readonly closed: Promise<T>;
  private settle!: { resolve: (value: T) => void; reject: (error: Error) => void };

  constructor(readonly host: UIHost, readonly id: string) {
    this.closed = new Promise<T>((resolve, reject) => this.settle = { resolve, reject });
    // nobody has to wait on how it ends
    this.closed.catch(() => { });
  }

  // ends it, with the value it ends with
  close(value?: T) {
    return this.host.client.request.handleClose({ id: this.id, value });
  }

  // brings its window to the front, restored if it was minimized - nothing,
  // for what has no window of its own (a dialog, a tray, a notification)
  focus() {
    return this.host.client.request.handleFocus({ id: this.id });
  }

  // opens a window in front of this one
  openWindow<W = unknown>(params: Omit<WindowParams, 'parent'>) {
    return this.host.openWindow<W>({ ...params, parent: this.id });
  }

  // shows a dialog in front of this one
  openDialog(params: Omit<DialogParams, 'parent'>) {
    return this.host.openDialog({ ...params, parent: this.id });
  }

  // opens a card window in front of this one
  openCard(params: Omit<CardParams, 'parent'>) {
    return this.host.openCard({ ...params, parent: this.id });
  }

  // opens a form window in front of this one
  openForm<F = unknown>(params: Omit<FormParams, 'parent'>) {
    return this.host.openForm<F>({ ...params, parent: this.id });
  }

  // opens what a factory opens, in front of this one
  open<P, H extends RemoteHandle<any>>(factory: UIFactory<P, H>, params: P): Promise<H> {
    return factory(this, params);
  }

  [end]({ value, error }: Omit<HandleClosedParams, 'id'>) {
    if (error !== undefined) this.settle.reject(new Error(error));
    else this.settle.resolve(value as T);
  }
}

export class RemoteWindow<T = unknown> extends RemoteHandle<T> { }

export class RemoteDialog extends RemoteHandle<DialogResult> { }

// a notification ends with 'click' if it was clicked, or nothing if it was
// dismissed (or closed from here)
export class RemoteNotification extends RemoteHandle<'click' | undefined> { }

// how a remote tray hears what happened to it - from its UIHost
const emit = Symbol('emit');

// a tray stays until it's closed, telling whoever listens when it's clicked
export class RemoteTray extends RemoteHandle<void> {
  private readonly listeners = new Set<(event: TrayEvent) => void>();

  // changes its icon, tooltip, title or menu - anything left out stays
  update(params: Partial<TrayParams>) {
    return this.host.client.request.trayUpdate({ ...params, id: this.id });
  }

  onEvent(listener: (event: TrayEvent) => void) {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }

  [emit](event: TrayEvent) {
    for (const listener of [...this.listeners]) listener(event);
  }
}

// a card ends with the Action.Submit chosen on it (and its inputs), or
// nothing if it was closed instead. Until then, whoever listens hears each
// Action.Execute chosen on it - and can show another card in its place.
export class RemoteCard extends RemoteHandle<CardEvent | undefined> {
  private readonly listeners = new Set<(event: CardEvent) => void>();

  // shows another card in its place
  update(card: CardUpdateParams['card']) {
    return this.host.client.request.cardUpdate({ id: this.id, card });
  }

  onEvent(listener: (event: CardEvent) => void) {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }

  [emit](event: CardEvent) {
    for (const listener of [...this.listeners]) listener(event);
  }
}

// a form ends with the data it was submitted with, or nothing if it was
// cancelled or closed
export class RemoteForm<F = unknown> extends RemoteHandle<F | undefined> { }

// what the host can do on the desktop beyond its own windows - Electron's
// shell, through the host
export class UIShellHandler {
  constructor(private readonly host: UIHost) { }

  // opens a link in the default browser (http and https), or mail app
  // (mailto) - anything else is refused
  openExternal(url: string) {
    return this.host.client.request.shellOpenExternal({ url });
  }
}

// the system clipboard, through the host
export class UIClipboardHandler {
  constructor(private readonly host: UIHost) { }

  writeText(text: string) {
    return this.host.client.request.clipboardWriteText({ text });
  }
}

export class UIHost implements UIOpener {
  static readonly protocol = uiHostProtocol;

  // defines a factory: only there to infer and check its params and handle,
  // the way defineProtocol is for protocols
  static factory<P, H extends RemoteHandle<any>>(factory: UIFactory<P, H>) {
    return factory;
  }

  // a host is its own: what a factory reaches through its opener
  get host() {
    return this;
  }

  readonly shell = new UIShellHandler(this);
  readonly clipboard = new UIClipboardHandler(this);
  private readonly messageListeners = new Set<(message: ConnectionMessage) => void>();
  private readonly remotes = new Map<string, RemoteHandle<any>>();
  // A handle can end before the reply saying it opened arrives: on macOS a
  // dialog with no parent holds the host up until it's answered, so its end
  // goes out ahead of the reply to dialog/open. An end for a handle not known
  // yet is kept here until its open is answered - for a while, not forever.
  private readonly unclaimed = new Map<string, HandleClosedParams>();
  // each open window's backend, by the key it was opened with - known before
  // the window is, so a page can never ask for one that isn't here yet
  private readonly backends = new Map<string, WindowBackend>();
  // tokens handed out and not yet used, each good for one connection to one
  // window's backend (by its key)
  private readonly tokens = new Map<string, string>();
  // where every window's backend is reached, started when a page first asks
  private backendServer?: Promise<WebSocketServer>;

  private constructor(readonly client: UIClient, readonly params: InitializeResult) {
    client.onRequest.windowConnect(params => this.connectWindow(params));
    client.onNotification.handleClosed(params => {
      const remote = this.remotes.get(params.id);
      this.remotes.delete(params.id);
      if (remote) return remote[end](params);
      this.unclaimed.set(params.id, params);
      setTimeout(() => this.unclaimed.delete(params.id), UNCLAIMED_MS).unref();
    });
    client.onNotification.trayEvent(({ id, ...event }) => {
      const remote = this.remotes.get(id);
      if (remote instanceof RemoteTray) remote[emit](event);
    });
    client.onNotification.cardEvent(({ id, ...event }) => {
      const remote = this.remotes.get(id);
      if (remote instanceof RemoteCard) remote[emit](event);
    });
    client.onNotification.connectionMessage(message => {
      for (const listener of [...this.messageListeners]) listener(message);
    });
    client.onClose(() => {
      for (const remote of this.remotes.values()) remote[end]({ error: 'the host went away' });
      this.remotes.clear();
      void this.closeBackendServer();
    });
  }

  // this UIHost's own connection id - what the others send to
  get connectionId() {
    return this.params.connectionId;
  }

  // every UIHost connected to the host, this one included, and which is the
  // owner
  connections() {
    return this.client.request.connections();
  }

  // sends a message to another of the app's UIHosts: the owner, unless to
  // names another connection. Settles once the host has passed it on, and
  // fails if there's no such connection.
  send(message: unknown, to?: string) {
    return this.client.request.connectionSend({ to, message });
  }

  // hears every message another UIHost sends this one
  onMessage(listener: (message: ConnectionMessage) => void) {
    this.messageListeners.add(listener);
    return { dispose: () => { this.messageListeners.delete(listener); } };
  }

  // a window's page asking for its backend: a token for one connection
  private async connectWindow({ backend }: WindowConnectParams): Promise<WindowConnectResult> {
    if (!this.backends.has(backend)) throw new Error('that window\'s backend is gone');
    const server = await (this.backendServer ??= this.startBackendServer());
    const token = randomBytes(24).toString('base64url');
    this.tokens.set(token, backend);
    return { url: getWebSocketUrl(server), token };
  }

  // one loopback WebSocket server for every window's backend. Anything on
  // this machine can reach it, so a connection gets in only with a token
  // from connectWindow - used once, and only for the window it was made for.
  private async startBackendServer() {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    server.on('connection', (socket, request) => {
      const token = new URL(request.url ?? '/', 'ws://backend').searchParams.get('token') ?? '';
      const key = this.tokens.get(token);
      this.tokens.delete(token);
      const backend = key === undefined ? undefined : this.backends.get(key);
      if (!backend) return socket.close(1008, 'not a token for an open window');
      backend(createWebSocket(socket)).listen();
    });
    return waitForWebSocketListening(server);
  }

  private async closeBackendServer() {
    const server = await this.backendServer;
    this.backendServer = undefined;
    if (!server) return;
    for (const socket of server.clients) socket.terminate();
    await closeWebSocketServer(server).catch(() => { });
  }

  // a window that's gone takes its backend, and any tokens for it, with it
  private forgetBackend(key: string) {
    this.backends.delete(key);
    for (const [token, owner] of this.tokens) if (owner === key) this.tokens.delete(token);
  }

  // starts ui-runtime's host, detached, for it to report where it can be
  // reached: its own address when it gets the app's single-instance lock, or
  // the lock holder's when it doesn't. Everything it needs goes through its
  // env - the app (CMDLESS_APP), the root (CMDLESS_ROOT) and where to report
  // (CMDLESS_SERVICE_SOCKET).
  static async create({ app, cmdlessRoot, timeoutMs, initialize }: CreateHostOptions = {}) {
    const sdkVersion = await getCmdlessUIVersion();
    const { binPath, env } = await resolvePackageBin(import.meta, '@cmdless/ui-runtime', sdkVersion, cmdlessRoot);
    if (app) setCmdlessApp(app, env);
    const { value } = await waitForService<HostService>(process.execPath, [binPath, 'host'], { env, timeoutMs });

    const client = await connectSocket(uiHostProtocol, { path: value.address });
    client.listen();
    try {
      const host = new UIHost(client, await client.request.init({ sdkVersion }));
      await initialize?.(host);
      await client.request.ready();
      return host;
    } catch (error) {
      client.dispose();
      throw error;
    }
  }

  // starts or joins a host, shows one window on it, and hands back the
  // value it ends with - leaving the host once it has
  static showWindow<T = unknown>(params: WindowParams, options?: CreateHostOptions) {
    return UIHost.once(options, host => host.openWindow<T>(params));
  }

  // the same for a dialog, handing back what was chosen
  static showDialog(params: DialogParams, options?: CreateHostOptions) {
    return UIHost.once(options, host => host.openDialog(params));
  }

  // the same for a card, handing back the Action.Submit chosen on it - or
  // nothing, if it was closed
  static showCard(params: CardParams, options?: CreateHostOptions) {
    return UIHost.once(options, host => host.openCard(params));
  }

  // asks an elicitation's question as a card, handing back its answer -
  // cancel, if the card was closed
  static async showElicitation(request: ElicitationRequest & { window?: WindowOptions }, options?: CreateHostOptions) {
    return elicitationResult(await UIHost.showCard({ card: elicitationCard(request), window: request.window }, options));
  }

  // asks a permission request as a card, handing back its outcome -
  // cancelled, if the card was closed
  static async showPermission(request: PermissionRequest & { window?: WindowOptions }, options?: CreateHostOptions) {
    return permissionResult(await UIHost.showCard({ card: permissionCard(request), window: request.window }, options));
  }

  // the same for a form, handing back what it was submitted with - or
  // nothing, if it was cancelled
  static showForm<F = unknown>(params: FormParams, options?: CreateHostOptions) {
    return UIHost.once(options, host => host.openForm<F>(params));
  }

  // the same for what a factory opens, handing back what it ends with
  static show<P, T>(factory: UIFactory<P, RemoteHandle<T>>, params: P, options?: CreateHostOptions) {
    return UIHost.once(options, host => factory(host, params));
  }

  private static async once<T>(options: CreateHostOptions | undefined, open: (host: UIHost) => Promise<RemoteHandle<T>>) {
    const host = await UIHost.create(options);
    try {
      return await (await open(host)).closed;
    } finally {
      host.dispose();
    }
  }

  // opens what a factory opens, on this host
  open<P, H extends RemoteHandle<any>>(factory: UIFactory<P, H>, params: P): Promise<H> {
    return factory(this, params);
  }

  // opens a window, once the host has - with a backend, its page can
  // connect() to this process directly, the host only introducing them
  async openWindow<T = unknown>({ backend, ...params }: WindowParams): Promise<RemoteWindow<T>> {
    if (!backend) {
      const { id } = await this.client.request.windowOpen(params);
      return this.track(new RemoteWindow<T>(this, id));
    }
    // the backend is here, under a key of its own, before the host hears of
    // the window - and goes when the window does, however it ends
    const key = randomBytes(12).toString('base64url');
    this.backends.set(key, backend);
    try {
      const { id } = await this.client.request.windowOpen({ ...params, backend: key });
      const window = this.track(new RemoteWindow<T>(this, id));
      void window.closed.catch(() => { }).finally(() => this.forgetBackend(key));
      return window;
    } catch (error) {
      this.forgetBackend(key);
      throw error;
    }
  }

  // shows a dialog, once the host has. On macOS, as in Electron, one with no
  // parent holds up the whole host until it's answered, and can't be closed
  // from here - open it from a window (RemoteHandle.openDialog) to avoid that.
  async openDialog(params: DialogParams) {
    const { id } = await this.client.request.dialogOpen(params);
    return this.track(new RemoteDialog(this, id));
  }

  // shows an OS notification, once the host has
  async showNotification(params: NotificationParams) {
    const { id } = await this.client.request.notificationShow(params);
    return this.track(new RemoteNotification(this, id));
  }

  // puts an icon in the tray, once the host has - it stays until it's closed
  async createTray(params: TrayParams) {
    const { id } = await this.client.request.trayCreate(params);
    return this.track(new RemoteTray(this, id));
  }

  // opens a window showing an Adaptive Card, once the host has
  async openCard(params: CardParams): Promise<RemoteCard> {
    const { id } = await this.client.request.cardOpen(params);
    return this.track(new RemoteCard(this, id));
  }

  // opens a window showing a form, once the host has
  async openForm<F = unknown>(params: FormParams): Promise<RemoteForm<F>> {
    const { id } = await this.client.request.formOpen(params);
    return this.track(new RemoteForm<F>(this, id));
  }

  private track<R extends RemoteHandle<any>>(remote: R) {
    const ended = this.unclaimed.get(remote.id);
    this.unclaimed.delete(remote.id);
    if (ended) remote[end](ended);
    else this.remotes.set(remote.id, remote);
    return remote;
  }

  onClose(listener: () => void) {
    return this.client.onClose(listener);
  }

  // leaves the host - which, for its owner, ends it
  dispose() {
    this.client.dispose();
    void this.closeBackendServer();
  }
}
