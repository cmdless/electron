import type { WebSocket as NodeWebSocket } from 'ws';

// The DOM WebSocket and `ws`'s WebSocket aren't structurally the same type,
// but both provide the send/onmessage/onerror/onclose/close shape our own
// ws helpers actually use - see connections.ts for why that's safe.
export type EitherWebSocket = WebSocket | NodeWebSocket;
