import '#ral'; // installs vscode-jsonrpc's runtime layer for whichever environment this runs in
import { createMessageConnection, } from 'vscode-jsonrpc';
import type {
  MessageConnection,
  MessageReader,
  MessageWriter,
} from "vscode-jsonrpc";

// every connection rpc-sdk makes, whatever it's over. vscode-jsonrpc
// rethrows a request's failed write from inside a promise executor, where
// nothing can catch it - so a request racing its own connection's dispose
// (its write failing once the transport's gone) would end the process. A
// write that fails after the connection is disposed is let go instead: the
// dispose has already rejected whatever was waiting on it. One that fails
// while it's live still fails.
export function createConnection(reader: MessageReader, writer: MessageWriter): MessageConnection {
  let disposed = false;
  const guarded: MessageWriter = {
    get onError() { return writer.onError; },
    get onClose() { return writer.onClose; },
    write: message => writer.write(message).catch(error => {
      if (!disposed) throw error;
    }),
    end: () => writer.end(),
    dispose: () => writer.dispose(),
  };
  const connection = createMessageConnection(reader, guarded);
  connection.onDispose(() => { disposed = true; });
  return connection;
}

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
    return createConnection(
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
    return createConnection(
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
    return createConnection(
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
