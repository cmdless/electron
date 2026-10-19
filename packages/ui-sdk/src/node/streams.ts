import net from 'node:net';
import EventEmitter from 'node:events';
import { getTmpSocketPath } from '@cmdless/core/node';

type MessageSocketEventMap<T> = { message: [T]; };
export class MessageSocket<T = any> extends EventEmitter<MessageSocketEventMap<T>> {
  private buffer = '';

  constructor(private readonly socket: net.Socket) {
    super();
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      this.buffer += chunk;
      let pos;
      while ((pos = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, pos);
        this.buffer = this.buffer.slice(pos + 1);
        this.emit('message', JSON.parse(line));
      }
    });
    this.socket = socket;
  }

  send(message: T) {
    this.socket.write((typeof message === 'string' ? message : JSON.stringify(message)) + '\n');
  }
}

export class MessageSocketWaiter<T> {
  readonly id = crypto.randomUUID();
  private readonly complete = new Promise<T>((resolver, rejecter) => {
    this.resolver = resolver;
    this.rejecter = rejecter;
  });
  private resolver?: (value: T | Promise<T>) => void;
  private rejecter?: (reason?: unknown) => void;
  private server?: net.Server;

  // a Promise ignores any settle call after the first, so a normal delivery
  // (message arrives, then the sender closes its socket) hits 'close' too -
  // that's a harmless no-op by then. This only matters for the case these
  // exist to catch: the sender (e.g. a primary instance forwarding a
  // second-instance request) dies mid-flight, before ever sending a message.
  start(): this {
    this.server ??= net.createServer(socket => {
      const message = new MessageSocket(socket);
      message.on('message', value => this.resolver?.(value));
      socket.on('error', error => this.rejecter?.(error));
      socket.on('close', () => this.rejecter?.(new Error('MessageSocketWaiter: connection closed before a message arrived')));
    }).listen(getTmpSocketPath(this.id));
    this.server.on('error', error => this.rejecter?.(error));
    return this;
  }

  stop(): this {
    if (this.server && this.server.listening)
      this.server.close(e => { if (e) console.error(e); });
    return this;
  }

  wait() { return this.complete; }

  async withResult(callback: (result: T) => void) {
    const message = await this.wait();
    callback(message);
    this.stop();
  }

  // an unhandled 'error' on a net.Socket throws, crashing this (sending)
  // process - without this, a dead receiver (e.g. a loser that already gave
  // up) would take the primary down with it while it's trying to forward.
  connect(id: string) {
    const rawSocket = net.createConnection(getTmpSocketPath(id));
    rawSocket.on('error', error => console.error('MessageSocketWaiter.connect: failed to deliver to', id, error));
    const socket = new MessageSocket(rawSocket);
    return (message: T) => socket.send(message);
  }
}
