import { createCallback } from '@cmdless/rpc-sdk';

// a message-at-a-time text pipe: a data channel, a WebSocket, ...
export type Pipe = {
  send: (text: string) => void;
  onMessage: (listener: (text: string) => void) => void;
  onClose: (listener: () => void) => void;
  close: () => void;
};

// the part of a data channel this needs - the browser's RTCDataChannel and
// werift's both have it
export type DataChannelLike = {
  send(data: string): void;
  close(): void;
  // typed loosely: the two define their own event types
  onmessage?: unknown;
  onclose?: unknown;
};

type Handlers = {
  onmessage: (event: { data: unknown }) => void;
  onclose: () => void;
};

export function fromDataChannel(channel: DataChannelLike): Pipe {
  const messageListeners: ((text: string) => void)[] = [];
  const closeListeners: (() => void)[] = [];
  const handled = channel as DataChannelLike & Handlers;
  handled.onmessage = ({ data }) => {
    const text = typeof data === 'string' ? data : new TextDecoder().decode(data as Uint8Array);
    for (const listener of messageListeners) listener(text);
  };
  handled.onclose = () => { for (const listener of closeListeners) listener(); };
  return {
    send: text => channel.send(text),
    onMessage: listener => { messageListeners.push(listener); },
    onClose: listener => { closeListeners.push(listener); },
    close: () => channel.close(),
  };
}

// a single data channel message is only safe up to about 64 KB on some
// stacks, and some messages (an AHP snapshot, say) are bigger - so each one
// goes as one or more parts: 'm' + text while more follows, 'e' + text for
// the last. A reliable, ordered channel keeps the parts in order.
const PART_LENGTH = 16_000;

export function chunked(pipe: Pipe): Pipe {
  let partial = '';
  const listeners: ((text: string) => void)[] = [];
  pipe.onMessage(part => {
    partial += part.slice(1);
    if (part[0] !== 'e') return;
    const text = partial;
    partial = '';
    for (const listener of listeners) listener(text);
  });
  return {
    send: text => {
      for (let start = 0; start < text.length || start === 0; start += PART_LENGTH) {
        const end = start + PART_LENGTH;
        pipe.send((end >= text.length ? 'e' : 'm') + text.slice(start, end));
        if (end >= text.length) break;
      }
    },
    onMessage: listener => { listeners.push(listener); },
    onClose: pipe.onClose,
    close: pipe.close,
  };
}

// a JSON-RPC connection over a pipe of whole messages - any protocol's
// client or server works over it. The connection is disposed when the pipe
// closes, so a peer's onClose sees it.
export function pipeConnection(pipe: Pipe): ReturnType<typeof createCallback> {
  const connection = createCallback(
    { subscribe: callback => { pipe.onMessage(text => callback(JSON.parse(text))); return () => { }; } },
    { send: message => pipe.send(JSON.stringify(message)), dispose: () => pipe.close() },
  );
  pipe.onClose(() => connection.dispose());
  return connection;
}
