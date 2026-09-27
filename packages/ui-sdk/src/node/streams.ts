import net from 'node:net';
import EventEmitter from 'node:events';
import { getTmpSocketPath } from './utils.js';

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
  private readonly complete = new Promise<T>(resolver => this.resolver = resolver);
  private resolver?: (value: T | Promise<T>) => void;
  private server?: net.Server;

  start(): this {
    this.server ??= net.createServer(socket => {
      new MessageSocket(socket).on('message', message => this.resolver?.(message));
    }).listen(getTmpSocketPath(this.id));
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

  connect(id: string) {
    const socket = new MessageSocket(net.createConnection(getTmpSocketPath(id)));
    return (message: T) => socket.send(message);
  }
}
