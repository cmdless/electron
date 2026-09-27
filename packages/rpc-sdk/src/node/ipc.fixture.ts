import { createIPC } from './connections.js';
import { defineProtocol } from '../protocol.js';

const protocol = defineProtocol(({ side, request }) => ({
  clientToServer: side({
    requests: { ping: request<{ text: string }, { text: string }>('ping') },
  }),
}));

const peer = protocol.createServer(createIPC(process));
peer.onRequest.ping(({ text }) => ({ text: text.toUpperCase() }));
peer.listen();
