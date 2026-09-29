import { z } from 'zod';
import type { RpcProtocol } from '@cmdless/rpc-sdk';

// Only the schema - name, description, and the shape of input/output. No
// handler lives here; that's attached on the node side (where the tool
// actually runs), and a browser-side facade can leverage the same schema to
// call it without needing to know how it's actually reached.
//
// Both inputSchema and outputSchema are constrained to an object schema
// (nested properties can be anything, including further nested objects -
// it's only the outer shape that's fixed). Per the MCP spec, a tool's input
// is always a dictionary of named arguments at the top level, and while the
// spec itself allows any JSON type for output, @modelcontextprotocol/sdk's
// own tool result handling requires structuredContent - and therefore
// outputSchema - to be object-shaped whenever outputSchema is declared at
// all (confirmed empirically: a non-object outputSchema fails at runtime
// with "Output validation error: ... no structured content was provided").
// protocol is optional, same as createShowCommand's own P generic - most
// tools are a plain request/response and never touch it, but a tool whose
// UI needs a live channel back to its own handler (rather than just its
// one-shot MCP input/output) declares one here, and a renderer representing
// that specific tool (createRenderer) connects to it.
export type AppTool<InSchema extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>, OutSchema extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>, P extends RpcProtocol = RpcProtocol> = {
  name: string;
  description: string;
  inputSchema: InSchema;
  outputSchema: OutSchema;
  protocol?: P;
};

export type ToolInput<T extends AppTool> = z.infer<T['inputSchema']>;
export type ToolOutput<T extends AppTool> = z.infer<T['outputSchema']>;
export type ToolProtocol<T extends AppTool> = T extends AppTool<infer _In, infer _Out, infer P> ? P : never;

function tool<InSchema extends z.ZodObject<z.ZodRawShape>, OutSchema extends z.ZodObject<z.ZodRawShape>, P extends RpcProtocol = RpcProtocol>(
  name: string,
  description: string,
  schemas: { input: InSchema; output: OutSchema; protocol?: P },
): AppTool<InSchema, OutSchema, P> {
  return { name, description, inputSchema: schemas.input, outputSchema: schemas.output, protocol: schemas.protocol };
}

export type AppToolsSpec = Record<string, AppTool>;

export type AppSpec<T extends AppToolsSpec = AppToolsSpec> = {
  name: string;
  description?: string;
  tools: T;
};

export type AppFactory<T extends AppToolsSpec> = (parameters: {
  tool: typeof tool;
  z: typeof z;
}) => AppSpec<T>;

export function defineApp<const T extends AppToolsSpec>(factory: AppFactory<T>): AppSpec<T> {
  return factory({ tool, z });
}
