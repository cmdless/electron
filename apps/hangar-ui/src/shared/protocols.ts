import { defineProtocol } from '@cmdless/rpc-sdk';

// what the bin serves the window it opens: just where hangar is. Everything
// else the window gets from hangar itself, over hangar's own protocol.
export const windowProtocol = defineProtocol(({ side, request }) => ({
  clientToServer: side({
    requests: {
      hangar: request<void, { url: string }>('hangar'),
    },
  }),
}));
