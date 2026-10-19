import { defineProtocol } from '@cmdless/rpc-sdk';

// what the daemon resolves as a service: only where to reach it. Anything
// that can change while it runs (like the AHP address) comes from asking it.
export type HangarService = {
  address: string;
};

export type HangarInfo = {
  // the daemon process, stable for as long as the daemon lives
  pid: number;
  // changes every time the daemon (re)creates its AHP host - a client that
  // sees a new one knows its AHP connection is to a host that's gone
  instanceId: string;
  // where the AHP host is served; the same across restarts
  ahpAddress: string;
};

export type RestartParams = {
  // restart even while a turn is running, ending it
  force?: boolean;
};

export const hangarProtocol = defineProtocol(({ side, request, notification }) => ({
  clientToServer: side({
    requests: {
      info: request<void, HangarInfo>('info'),
      restart: request<RestartParams, HangarInfo>('restart'),
    },
  }),
  serverToClient: side({
    notifications: {
      restarted: notification<HangarInfo>('restarted'),
    },
  }),
}));
