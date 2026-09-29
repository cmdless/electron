import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { WebSocket } from 'ws';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { runAsMcp } from './utils.js';

const fixture = fileURLToPath(new URL('./app.fixture.ts', import.meta.url));

// mirrors the WebSocketTransport in app.ts, for the client side.
class ClientWsTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private readonly ready: Promise<void>;

  constructor(private readonly socket: WebSocket) {
    this.ready = new Promise(resolve => socket.once('open', () => resolve()));
    socket.on('message', data => this.onmessage?.(JSON.parse(data.toString())));
    socket.on('close', () => this.onclose?.());
    socket.on('error', error => this.onerror?.(error));
  }

  async start() { await this.ready; }
  async send(message: JSONRPCMessage) { this.socket.send(JSON.stringify(message)); }
  async close() { this.socket.close(); }
}

test('mcp subcommand speaks standard stdio when launched normally (no ipc)', async () => {
  // exactly how an external MCP client (e.g. Claude Desktop) would spawn
  // and talk to this - no cmdless-specific knowledge needed.
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', fixture, 'mcp'],
  });
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(transport);

  try {
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map(t => t.name), ['echo']);

    const result = await client.callTool({ name: 'echo', arguments: { text: 'hi' } });
    assert.deepEqual(result.structuredContent, { text: 'hi' });
  } finally {
    await client.close();
  }
});

test('runAsMcp resolves a local package, gets its address over ipc, and the tool round-trips over websocket', async () => {
  // findLocalBinPath (used internally by runAsMcp) relies on real node
  // module resolution, so this fakes a minimal installed package - a
  // node_modules/<name>/package.json whose "bin" points back at the fixture.
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cmdless-mcp-test-'));
  const packageName = 'cmdless-mcp-test-fixture';
  const pkgDir = path.join(tmpRoot, 'node_modules', packageName);
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
    name: packageName,
    bin: { [packageName]: path.relative(pkgDir, fixture) },
  }));
  // a fake caller location under tmpRoot - only its directory matters, the
  // file itself doesn't need to exist for module resolution to work.
  const meta = { url: pathToFileURL(path.join(tmpRoot, 'caller.js')).href } as ImportMeta;

  // the fixture is run from source (.ts), which needs tsx - runAsMcp spawns
  // via a bare `node <binPath>`, so this is supplied through the child's
  // inherited env rather than as a spawn arg (a published package's real
  // bin would be plain compiled .js and wouldn't need this at all).
  const originalNodeOptions = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `${originalNodeOptions ?? ''} --import tsx`.trim();

  try {
    const { address, dispose } = await runAsMcp(meta, packageName);
    try {
      const client = new Client({ name: 'test-client', version: '0.0.0' });
      await client.connect(new ClientWsTransport(new WebSocket(address)));
      try {
        const result = await client.callTool({ name: 'echo', arguments: { text: 'hi' } });
        assert.deepEqual(result.structuredContent, { text: 'hi' });
      } finally {
        await client.close();
      }
    } finally {
      await dispose();
    }
  } finally {
    process.env.NODE_OPTIONS = originalNodeOptions;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
