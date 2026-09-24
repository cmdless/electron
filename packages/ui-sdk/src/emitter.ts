export type EmitterEventMap = Record<string, readonly unknown[]>;

export class Emitter<TSend extends EmitterEventMap = {}, TReceive extends EmitterEventMap = TSend> {
  private readonly target = new EventTarget();
  private readonly handlers = new WeakMap<Function, EventListener>();

  on<K extends keyof TReceive>(type: K, handler: (...args: TReceive[K]) => void): this {
    const wrapped: EventListener = (event) => {
      handler(...(event as CustomEvent<TReceive[K]>).detail);
    };
    this.handlers.set(handler, wrapped);
    this.target.addEventListener(type as string, wrapped);
    return this;
  }

  once<K extends keyof TReceive>(type: K, handler: (...args: TReceive[K]) => void): this {
    const wrapped: EventListener = (event) => {
      this.handlers.delete(handler);
      handler(...(event as CustomEvent<TReceive[K]>).detail);
    };
    this.handlers.set(handler, wrapped);
    this.target.addEventListener(type as string, wrapped, { once: true });
    return this;
  }

  off<K extends keyof TReceive>(type: K, handler: (...args: TReceive[K]) => void): this {
    const wrapped = this.handlers.get(handler);
    if (wrapped) {
      this.target.removeEventListener(type as string, wrapped);
      this.handlers.delete(handler);
    }
    return this;
  }

  emit<K extends keyof TSend>(type: K, ...args: TSend[K]): boolean {
    return this.target.dispatchEvent(new CustomEvent(type as string, { detail: args }));
  }

  subscribe<K extends keyof TReceive>(type: K, handler: (...args: TReceive[K]) => void): () => void {
    this.on(type, handler);
    return () => this.off(type, handler);
  }
}