import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createShowCommand } from '@cmdless/ui-sdk/node';
import { defineGetProtocol } from '../shared/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distIndex = path.join(__dirname, '../../dist/index.html');

// each picker points at its own hash route within the one built bundle,
// so a single-page renderer can tell which top-level UI to show - in dev
// mode, createShowCommand's CMDLESS_URL override preserves whatever hash
// the original source carried, so routing keeps working against the dev
// server too, not just the built file.
export function pickerSource(route: string) {
  return `${distIndex}#${route}`;
}

// a picker window resolves with `null` if the user closes/cancels instead
// of actually picking, rather than rejecting - surfaced as a rejection
// here so a cancellation is never mistaken for a real (empty) value.
function requireValue<T>(value: T | null): T {
  if (value === null) throw new Error('cancelled');
  return value;
}

export function createPicker<Out>(route: string) {
  return createShowCommand<void, Out>({
    params: () => ({ type: 'file', source: pickerSource(route) }),
    result: (_, stdout) => requireValue(JSON.parse(stdout)),
  });
}

// like createPicker, but for a window that needs the actual invocation
// input available to it (e.g. relaying an ACP request's own payload) - a
// one-request RpcProtocol carries it over, closing directly over `input`
// rather than needing any generic way to pass data into a shown window.
// Cancelling (`Out` including `null`) is the caller's call, not baked in
// here, since some of these treat "closed" as a real outcome, not an abort.
export function createInputPicker<In, Out>(route: string) {
  const protocol = defineGetProtocol<In>();

  return createShowCommand<In, Out>({
    params: () => ({ type: 'file', source: pickerSource(route) }),
    transport: async input => {
      const { accept } = await protocol.defineHost({
        configure: peer => peer.onRequest.get(() => input),
      })();
      return { accept, options: { port: 0, host: '127.0.0.1' } };
    },
    result: (_, stdout) => JSON.parse(stdout),
  });
}
