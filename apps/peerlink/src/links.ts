import WebSocket from 'ws';
import type { Pipe } from '@cmdless/rtc-sdk';
import type { LinkTarget } from '@cmdless/peerlink-sdk';

// what a channel's label names on this device, if it's a target at all
export function targetOf(label: string): LinkTarget | undefined {
  try {
    const target = JSON.parse(label) as LinkTarget;
    if (typeof target === 'object' && target && ('offerId' in target || 'address' in target)) return target;
  } catch { }
  return undefined;
}

// a channel another device opened, relayed to the local address its target
// resolved to - one of this device's offers, never anything else
export function relay(pipe: Pipe, address: string) {
  const socket = new WebSocket(address);
  // whatever arrives before the socket is open waits for it
  const waiting: string[] = [];
  pipe.onMessage(text => socket.readyState === WebSocket.OPEN ? socket.send(text) : waiting.push(text));
  socket.on('open', () => { for (const text of waiting.splice(0)) socket.send(text); });
  socket.on('message', data => pipe.send(data.toString()));
  socket.on('close', () => pipe.close());
  socket.on('error', () => pipe.close());
  pipe.onClose(() => socket.close());
}
