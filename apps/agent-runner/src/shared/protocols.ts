import { defineProtocol } from '@cmdless/rpc-sdk';
import type * as acp from '@agentclientprotocol/sdk';

// a one-request protocol for conveying a picker's invocation input to its
// window. Node and browser each build their own instance from this same
// factory - RpcProtocol objects don't need to be object-identical to
// interoperate, just the same method names/shapes - so a window can read
// whatever it was opened for without any generic way to pass data into a
// shown window at all.
export function defineGetProtocol<T>() {
  return defineProtocol(({ side, request }) => ({
    clientToServer: side({
      requests: {
        get: request<void, T>('get'),
      },
    }),
    serverToClient: side({}),
  }));
}

// the conversation window's protocol - shared directly rather than via a
// factory, since its shape is fixed, not parameterized per use.
export const conversationProtocol = defineProtocol(({ side, request, notification }) => ({
  clientToServer: side({
    requests: {
      sendPrompt: request<{ text: string }, void>('sendPrompt'),
    },
  }),
  serverToClient: side({
    notifications: {
      update: notification<acp.SessionNotification>('update'),
      stop: notification<{ stopReason: string }>('stop'),
    },
  }),
}));
