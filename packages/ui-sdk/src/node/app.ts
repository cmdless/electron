import { WebSocketServer, type WebSocket } from 'ws';
import { Command } from 'commander';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { AppSpec, AppTool, AppToolsSpec, ToolInput, ToolOutput } from '../app.js';

export type ToolHandler<T extends AppTool> = (input: ToolInput<T>) => Promise<ToolOutput<T>>;

export type ToolHandlers<T extends AppToolsSpec> = {
  [K in keyof T]: ToolHandler<T[K]>;
};

export type McpHandle = {
  address: string;
  dispose: () => Promise<void>;
};

export type App<T extends AppToolsSpec> = {
  spec: AppSpec<T>;
  tools: ToolHandlers<T>;
  // builds the Commander program ("tool <name> [json] [--flags]" and "mcp"
  // subcommands, generated from spec) - returned directly (not pre-parsed),
  // so it's obvious what you're getting and it composes like any other
  // commander program (add subcommands, .parse() it yourself, etc).
  cli: () => Command;
  // cli().parseAsync(argv)
  run: (argv?: readonly string[]) => Promise<void>;
  // just the MCP server half of cli()'s "mcp" subcommand, exposed directly
  // for programmatic embedding without going through argv at all. Starts
  // over a plain WebSocket (not stdio - a browser-side facade can open a
  // WebSocket directly, but can't speak stdio or spawn a process at all).
  mcp: () => Promise<McpHandle>;
};

// --- MCP transport: a plain WebSocket, not one of MCP's own standard
// transports (stdio / Streamable HTTP) - this is for a renderer-side
// facade to connect to directly, which can open a WebSocket but can't
// spawn a process or speak stdio. Transport itself is protocol-agnostic
// (just send/onmessage/onclose/onerror/close), so this is a thin adapter.
class WebSocketTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(private readonly socket: WebSocket) {
    socket.on('message', data => {
      try {
        this.onmessage?.(JSON.parse(data.toString()));
      } catch (error) {
        this.onerror?.(error as Error);
      }
    });
    socket.on('close', () => this.onclose?.());
    socket.on('error', error => this.onerror?.(error));
  }

  async start() { }

  async send(message: JSONRPCMessage) {
    this.socket.send(JSON.stringify(message));
  }

  async close() {
    this.socket.close();
  }
}

// outputSchema is always object-shaped (see app.ts), so structuredContent
// is always safe to include here.
function toolResult(value: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function buildMcpServer<T extends AppToolsSpec>(spec: AppSpec<T>, handlers: ToolHandlers<T>): McpServer {
  const server = new McpServer({ name: spec.name, version: '0.0.0' });
  for (const tool of Object.values(spec.tools) as AppTool[]) {
    // the SDK's zod-compat layer expects zod/v4/core's $ZodType, which our
    // top-level `zod` import is structurally close to but not identical to
    // at the type level - runtime behavior (validation, JSON Schema
    // conversion) is unaffected, this is purely a type-level mismatch, so
    // the whole call is cast rather than fighting overload resolution.
    (server.registerTool as (...args: unknown[]) => unknown)(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema, outputSchema: tool.outputSchema },
      async (input: unknown) => toolResult(await (handlers as Record<string, ToolHandler<AppTool>>)[tool.name](input as never)),
    );
  }
  return server;
}

async function startMcp<T extends AppToolsSpec>(spec: AppSpec<T>, handlers: ToolHandlers<T>): Promise<McpHandle> {
  const mcpServer = buildMcpServer(spec, handlers);

  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve, reject) => {
    wss.once('listening', resolve);
    wss.once('error', reject);
  });

  wss.on('connection', socket => {
    mcpServer.connect(new WebSocketTransport(socket)).catch(error => console.error(error));
  });

  const addr = wss.address();
  if (!addr || typeof addr === 'string')
    throw new Error('MCP WebSocket server has no usable address');
  const address = `ws://127.0.0.1:${addr.port}`;

  let disposed = false;
  const dispose = () => {
    if (disposed) return Promise.resolve();
    disposed = true;
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    return new Promise<void>((resolve, reject) => {
      wss.close(error => error ? reject(error) : resolve());
    });
  };
  const onSignal = () => { dispose().catch(() => { }); };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  return { address, dispose };
}

// --- CLI: unwraps z.ZodOptional/z.ZodDefault to inspect the underlying
// type, since those don't change what a --flag for that field looks like.
// Typed loosely (rather than z.ZodType) - the shape values coming off an
// AppTool with its default (widened) generic don't structurally match
// z.ZodType exactly, even though they're the same schemas at runtime; the
// instanceof checks below are what actually matters.
function unwrap(schema: unknown): unknown {
  let s = schema;
  while (s instanceof z.ZodOptional || s instanceof z.ZodDefault)
    s = s instanceof z.ZodOptional ? s.unwrap() : s.removeDefault();
  return s;
}

function isFlaggable(schema: unknown): boolean {
  const s = unwrap(schema);
  return s instanceof z.ZodString || s instanceof z.ZodNumber || s instanceof z.ZodBoolean || s instanceof z.ZodEnum
    || s instanceof z.ZodObject || s instanceof z.ZodRecord;
}

function coerceFlag(schema: unknown, raw: string | boolean): unknown {
  const s = unwrap(schema);
  if (s instanceof z.ZodNumber) return Number(raw);
  if (s instanceof z.ZodObject || s instanceof z.ZodRecord) return JSON.parse(raw as string);
  return raw;
}

function addToolCommand(parent: Command, tool: AppTool, handler: ToolHandler<AppTool>) {
  const command = parent.command(tool.name).description(tool.description);
  command.argument('[json]', 'JSON object to use as the base input (merged with any flags below)');

  const fields = Object.entries(tool.inputSchema.shape);
  for (const [key, fieldSchema] of fields) {
    if (!isFlaggable(fieldSchema)) continue;
    const flag = `--${key}`;
    if (unwrap(fieldSchema) instanceof z.ZodBoolean) command.option(flag);
    else command.option(`${flag} <value>`);
  }

  command.action(async (json: string | undefined, options: Record<string, string | boolean>) => {
    const base = json ? JSON.parse(json) : {};
    const overrides: Record<string, unknown> = {};
    for (const [key, fieldSchema] of fields)
      if (options[key] !== undefined) overrides[key] = coerceFlag(fieldSchema, options[key]);

    const input = { ...base, ...overrides };
    const parsed = tool.inputSchema.safeParse(input);
    if (!parsed.success) {
      console.error(`Invalid input for tool "${tool.name}":`, z.prettifyError(parsed.error));
      process.exitCode = 1;
      return;
    }

    const result = await handler(parsed.data);
    process.stdout.write(JSON.stringify(result));
  });
}

function buildCli<T extends AppToolsSpec>(spec: AppSpec<T>, handlers: ToolHandlers<T>, startup?: () => void | Promise<void>): Command {
  const program = new Command(spec.name);
  if (spec.description) program.description(spec.description);

  // fires only when no subcommand is given (commander's default-command
  // behavior) - lets a consumer (e.g. electron main) decide what "just run
  // me" means, without that having to be a tool of its own.
  if (startup) program.action(() => startup());

  const toolGroup = program.command('tool').description('Invoke a tool directly');
  for (const tool of Object.values(spec.tools) as AppTool[])
    addToolCommand(toolGroup, tool, (handlers as Record<string, ToolHandler<AppTool>>)[tool.name]);

  program.command('mcp').description('Start an MCP server').action(async () => {
    // normal usage (a human, or an external MCP client like Claude Desktop
    // spawning this directly) gets the standard MCP transport: stdio,
    // connected directly, no address involved at all - that's what every
    // MCP client already expects. An 'ipc' channel present means this was
    // launched by runAsMcp specifically (main mediating for a renderer,
    // which can open a WebSocket but can't speak stdio) - only then do we
    // start over a WebSocket instead and report the address back over ipc.
    if (process.send) {
      const { address } = await startMcp(spec, handlers);
      process.send({ address });
      await new Promise(() => { }); // keep running until killed
    } else {
      await buildMcpServer(spec, handlers).connect(new StdioServerTransport());
    }
  });

  return program;
}

// called once per instance (i.e. once per createApp() factory call) rather
// than handlers being handed over ready-made, so consumers can close over
// per-instance state (e.g. a registry of running agents) and have their
// handlers share it, without that state leaking across instances.
export type AppSetup<T extends AppToolsSpec> = () => ToolHandlers<T>;

export type AppOptions<T extends AppToolsSpec> = {
  spec: AppSpec<T>;
  setup: AppSetup<T>;
  // invoked when the CLI is run with no subcommand - e.g. an electron app's
  // "just launch the window" behavior. Receives the app itself, so it can
  // use .tools directly rather than going through the CLI or MCP.
  startup?: (app: App<T>) => void | Promise<void>;
};

// a factory rather than a plain instance - a consumer's own src/node/app.ts
// does `export default createApp(options)`, and whatever loads it (a vite
// plugin's dev-mode HMR, a bin entrypoint) calls the factory itself to get
// a fresh instance, e.g. `app().run()`.
export function createApp<T extends AppToolsSpec>(options: AppOptions<T>): () => App<T> {
  return () => {
    const { spec, startup: onStartup } = options;
    const tools = options.setup();
    const startup = onStartup ? () => onStartup(app) : undefined;
    const app: App<T> = {
      spec,
      tools,
      cli: () => buildCli(spec, tools, startup),
      run: argv => buildCli(spec, tools, startup).parseAsync(argv as string[] | undefined).then(() => { }),
      mcp: () => startMcp(spec, tools),
    };
    return app;
  };
}
