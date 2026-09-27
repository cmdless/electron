import 'vscode-jsonrpc/browser'; // installs the browser runtime abstraction layer WebSocketMessageReader/Writer need
import type { RpcProtocol, RpcPeer } from '@cmdless/rpc-sdk';
import { connectWebSocket } from '@cmdless/rpc-sdk/ws';
import type { Cmdless } from '../index.js';

export class CmdlessRenderer<P extends RpcProtocol> {
  rpc?: RpcPeer<P['client']>;

  constructor(private readonly protocol: P) {
    this.ipc.request.connectionInfo().then(({ address }) => {
      if (!address) return;
      return connectWebSocket(this.protocol, { url: address }).then(rpc => {
        rpc.listen();
        this.rpc = rpc;
      });
    });
  }

  get attached() { return !!window.cmdless; }
  get connected() { return !!this.rpc; }

  get ipc() {
    if (!window.cmdless)
      throw new Error('window.cmdless not found');
    return window.cmdless.ipc;
  }
}

export type { Cmdless };
