import { createMessageConnection, } from 'vscode-jsonrpc';
import type {
  MessageConnection,
  MessageReader,
  MessageWriter,
} from "vscode-jsonrpc";

type ReaderCtor<T> = new (input: T) => MessageReader;
type WriterCtor<T> = new (output: T) => MessageWriter;

export function defineConnection<
  TInput,
  TOutput,
  TEndpoint extends TInput & TOutput = TInput & TOutput,
>(
  Reader: ReaderCtor<TInput>,
  Writer: WriterCtor<TOutput>,
) {
  function create(endpoint: TEndpoint): MessageConnection;
  function create(input: TInput, output: TOutput): MessageConnection;
  function create(input: TInput, output: TOutput = input as unknown as TOutput) {
    return createMessageConnection(
      new Reader(input),
      new Writer(output),
    );
  }

  return create;
}

export function defineSplitConnection<
  TInput,
  TOutput,
>(
  Reader: ReaderCtor<TInput>,
  Writer: WriterCtor<TOutput>,
) {
  return function create(input: TInput, output: TOutput) {
    return createMessageConnection(
      new Reader(input),
      new Writer(output),
    );
  }
}

export function defineDuplexConnection<
  TInput,
  TOutput,
  TEndpoint extends TInput & TOutput = TInput & TOutput,
>(
  Reader: ReaderCtor<TInput>,
  Writer: WriterCtor<TOutput>,
) {
  return function create(endpoint: TEndpoint) {
    return createMessageConnection(
      new Reader(endpoint),
      new Writer(endpoint),
    );
  };
}

import { Disposable, AbstractMessageReader, AbstractMessageWriter } from 'vscode-jsonrpc';
import type { DataCallback, Message } from 'vscode-jsonrpc';

type CallbackReceiver = {
  subscribe: (callback: DataCallback) => () => void;
};

export type CallbackSender = {
  send: DataCallback;
  dispose?: () => void;
};

class CallbackMessageReader extends AbstractMessageReader {
  private callback?: DataCallback;
  private unsubscribe: Disposable;

  constructor(receiver: CallbackReceiver) {
    super();
    this.unsubscribe = Disposable.create(receiver.subscribe(message => this.callback?.(message)));
  }

  override listen(callback: DataCallback) {
    this.callback = callback;
    return Disposable.create(() => {
      this.callback = undefined;
    });
  }

  override dispose(): void {
    super.dispose();
    this.unsubscribe.dispose();
  }
}

class CallbackMessageWriter extends AbstractMessageWriter {
  constructor(private readonly sender: CallbackSender) {
    super();
  }

  write(message: Message) {
    this.sender.send(message);
    return Promise.resolve();
  }

  end() { }

  override dispose() {
    super.dispose();
    this.sender.dispose?.();
  }
}

export const createCallback = defineSplitConnection(CallbackMessageReader, CallbackMessageWriter);

export function splitSourceFor<In, Out>(create: (input: In, output: Out) => MessageConnection) {
  return function <T>(
    input: (source: T) => Parameters<typeof create>[0],
    output: (source: T) => Parameters<typeof create>[1],
  ) {
    return (source: T) => create(input(source), output(source));
  };
}

export type ElectronIPCReceiver = {
  on: (channel: string, listener: (e: unknown, message: Message) => void) => void;
  off: (channel: string, listener: (e: unknown, message: Message) => void) => void;
};

export type ElectronIPCSender = {
  send: (channel: string, message: Message) => void;
};

export type ElectronIPCLike = ElectronIPCSender & ElectronIPCReceiver;

export function asElectronIPC(receiver: ElectronIPCReceiver, sender: ElectronIPCSender): ElectronIPCLike {
  return {
    on: receiver.on.bind(receiver),
    off: receiver.off.bind(receiver),
    send: sender.send.bind(sender),
  };
}

export function forElectronIPC<T extends ElectronIPCLike>(channel: string) {
  return splitSourceFor(createCallback)<T>(
    source => ({
      subscribe: callback => {
        const listener = (_event: unknown, message: Message) => callback(message);
        source.on(channel, listener);
        return () => source.off(channel, listener);
      }
    }),
    source => ({
      send: message => source.send(channel, message),
    }),
  );
}

export {
  createMessageConnection,
  Disposable,
  AbstractMessageReader,
  AbstractMessageWriter
};
export type {
  MessageConnection,
  MessageReader,
  MessageWriter,
  DataCallback,
  Message
};
