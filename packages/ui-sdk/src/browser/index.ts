import 'vscode-jsonrpc/browser'; // installs the browser runtime abstraction layer WebSocketMessageReader/Writer need
import type { RpcProtocol, RpcPeer } from '@cmdless/rpc-sdk';
import { connectWebSocket } from '@cmdless/rpc-sdk/ws';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { AppSpec, AppTool, AppToolsSpec, ToolInput, ToolOutput, ToolProtocol } from '../app.js';
import type { Cmdless } from '../index.js';

export type { Cmdless };

// --- createClient: a facade over an app's MCP server, from the renderer.
// Mirrors App<T>.tools' shape (same input/output per tool), but each call
// lazily connects over MCP the first time any tool is actually invoked,
// rather than eagerly on construction.

function getCmdless(): Cmdless {
  if (!window.cmdless)
    throw new Error('window.cmdless not found');
  return window.cmdless;
}

// mirrors node/app.ts's server-side WebSocketTransport, for the client side.
class ClientWebSocketTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private readonly ready: Promise<void>;

  constructor(private readonly socket: WebSocket) {
    this.ready = new Promise(resolve => socket.addEventListener('open', () => resolve(), { once: true }));
    socket.addEventListener('message', event => this.onmessage?.(JSON.parse(event.data as string)));
    socket.addEventListener('close', () => this.onclose?.());
    socket.addEventListener('error', () => this.onerror?.(new Error('MCP WebSocket error')));
  }

  async start() { await this.ready; }
  async send(message: JSONRPCMessage) { this.socket.send(JSON.stringify(message)); }
  async close() { this.socket.close(); }
}

export type ClientToolHandler<T extends AppTool> = (input: ToolInput<T>) => Promise<ToolOutput<T>>;

export type ClientTools<T extends AppToolsSpec> = {
  [K in keyof T]: ClientToolHandler<T[K]>;
};

export type ClientApp<T extends AppToolsSpec> = {
  spec: AppSpec<T>;
  tools: ClientTools<T>;
};

export type ClientInfo = { name: string; version: string };

// closes over spec/name/version at call time (no window/websocket touched
// yet), so this can sit in a consumer's shared/ export and be imported by
// itself (self) or by another app (sibling) without either needing to know
// which - `packageName` is all main needs to tell them apart.
export type ClientFactory<T extends AppToolsSpec> = (cmdless: Cmdless) => ClientApp<T>;

export function createClient<T extends AppToolsSpec>(spec: AppSpec<T>, info: ClientInfo): ClientFactory<T> {
  return cmdless => {
    let mcp: Promise<McpClient> | undefined;
    const connect = () => mcp ??= cmdless.ipc.request.mcpAddress({ packageName: info.name, version: info.version })
      .then(async ({ address }) => {
        const client = new McpClient({ name: info.name, version: info.version });
        await client.connect(new ClientWebSocketTransport(new WebSocket(address)));
        return client;
      });

    const tools = {} as ClientTools<T>;
    for (const tool of Object.values(spec.tools) as AppTool[]) {
      (tools as Record<string, ClientToolHandler<AppTool>>)[tool.name] = async input => {
        const client = await connect();
        const result = await client.callTool({ name: tool.name, arguments: input as Record<string, unknown> });
        return result.structuredContent as never;
      };
    }

    return { spec, tools };
  };
}

// --- createRenderer: the renderer side of one specific tool. `tool` gives
// it its own name/description (so it knows what it represents) and its
// optional live protocol (so it knows whether to connect one); `client` is
// the renderer's own app (for its other tools, via MCP); `apps` are sibling
// apps' tools, reached the same way.
export type RendererApps = Record<string, ClientFactory<AppToolsSpec>>;

export type RendererClients<Apps extends RendererApps> = {
  [K in keyof Apps]: Apps[K] extends ClientFactory<infer T> ? ClientApp<T> : never;
};

export type RendererOptions<T extends AppToolsSpec, Tool extends AppTool, Apps extends RendererApps> = {
  client: ClientFactory<T>;
  tool: Tool;
  apps?: Apps;
};

export class Renderer<T extends AppToolsSpec, Tool extends AppTool, Apps extends RendererApps> {
  readonly client: ClientApp<T>;
  readonly apps: RendererClients<Apps>;
  rpc?: RpcPeer<NonNullable<ToolProtocol<Tool>>['client']>;

  constructor(private readonly tool: Tool, client: ClientFactory<T>, apps?: Apps) {
    const cmdless = this.cmdless;
    this.client = client(cmdless);
    this.apps = Object.fromEntries(
      Object.entries(apps ?? {}).map(([key, factory]) => [key, factory(cmdless)]),
    ) as RendererClients<Apps>;

    if (tool.protocol) {
      const protocol = tool.protocol as RpcProtocol;
      this.ipc.request.connectionInfo().then(({ address }) => {
        if (!address) return;
        return connectWebSocket(protocol, { url: address }).then(rpc => {
          rpc.listen();
          this.rpc = rpc as never;
        });
      });
    }
  }

  get name() { return this.tool.name; }
  get description() { return this.tool.description; }

  get attached() { return !!window.cmdless; }
  get connected() { return !!this.rpc; }

  get cmdless() { return getCmdless(); }
  get ipc() { return this.cmdless.ipc; }
}

export function createRenderer<T extends AppToolsSpec, Tool extends AppTool, Apps extends RendererApps>(
  options: RendererOptions<T, Tool, Apps>,
): Renderer<T, Tool, Apps> {
  return new Renderer(options.tool, options.client, options.apps);
}
