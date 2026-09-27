import { startStdio } from './connections.js';
import { defineProtocol } from '../protocol.js';

const protocol = defineProtocol(({ side, request }) => ({
  clientToServer: side({
    requests: { ping: request<{ text: string }, { text: string }>('ping') },
  }),
}));

await startStdio({
  protocol,
  configure: peer => {
    peer.onRequest.ping(({ text }) => ({ text: text.toUpperCase() }));
  },
});
