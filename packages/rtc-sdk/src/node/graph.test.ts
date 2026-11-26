import test from 'node:test';
import assert from 'node:assert/strict';
import { createRtcHost, graphApp, graphAppFolderPath, graphAppFolderSignaling, parseProvider, providerLabel, signalingFor } from './index.js';
import type { Device, RtcHost } from './index.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';

// Graph, as much of it as signaling uses, over an in-memory drive: an item
// by path under a root, its content, a folder's children with eTags - and a
// token it refuses once, and a request it throttles once, to be got past
function fakeGraph(root: string) {
  const files = new Map<string, { text: string; version: number }>();
  const calls: string[] = [];
  let version = 0;
  let refuse = 'stale-token';
  let throttled = false;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const missing = () => json({ error: { code: 'itemNotFound', message: 'not found' } }, 404);

  const fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    calls.push(`${method} ${url}`);
    const token = (init.headers as Record<string, string>).authorization?.replace('Bearer ', '');
    if (token === refuse) return json({ error: { code: 'InvalidAuthenticationToken', message: 'expired' } }, 401);
    if (!throttled && method === 'PUT') {
      throttled = true;
      return new Response('', { status: 429, headers: { 'retry-after': '0' } });
    }
    assert.ok(url.startsWith(`${GRAPH}${root}:/`), `outside the root: ${url}`);
    const rest = url.slice(`${GRAPH}${root}:/`.length);
    const [, encoded, tail] = /^(.*?):(\/.*)?$/.exec(rest)!;
    const path = encoded.split('/').map(decodeURIComponent).join('/');
    if (tail === '/content' && method === 'PUT') {
      files.set(path, { text: String(init.body), version: ++version });
      return json({ name: path.split('/').pop() }, 201);
    }
    if (tail === '/content') {
      const file = files.get(path);
      return file ? new Response(file.text) : missing();
    }
    if (tail?.startsWith('/children')) {
      const inside = [...files].filter(([name]) => name.startsWith(`${path}/`) && !name.slice(path.length + 1).includes('/'));
      if (!inside.length) return missing();
      return json({ value: inside.map(([name, file]) => ({ name: name.slice(path.length + 1), eTag: `"${file.version}"`, file: {} })) });
    }
    if (method === 'DELETE') return files.delete(path) ? new Response(null, { status: 204 }) : missing();
    throw new Error(`not faked: ${method} ${url}`);
  };
  return { fetch, files, calls, refuseNoMore: () => { refuse = ''; } };
}

test('a Graph App folder is personal, a drive\'s or a site\'s', () => {
  assert.equal(graphAppFolderPath({ type: 'personal' }), '/me/drive/special/approot');
  assert.equal(graphAppFolderPath({ type: 'drive', driveId: 'b!abc' }), '/drives/b!abc/special/approot');
  assert.equal(graphAppFolderPath({ type: 'site', siteId: 'contoso.sharepoint.com,1,2' }), '/sites/contoso.sharepoint.com,1,2/drive/special/approot');
  assert.throws(() => graphAppFolderPath({ type: 'drive', driveId: '' }));
  assert.throws(() => graphAppFolderPath({ type: 'site', siteId: 'a/b' }));
  assert.deepEqual(graphApp('tenant', 'client').scopes, ['Files.ReadWrite.AppFolder', 'offline_access']);
  // nothing hosted: Microsoft's own page for native apps, unless another is given
  assert.equal(graphApp('tenant', 'client').redirectUri, 'https://login.microsoftonline.com/common/oauth2/nativeclient');
  assert.equal(graphApp('tenant', 'client', 'http://localhost').redirectUri, 'http://localhost');
  assert.equal(graphApp('tenant', 'client').tokenUrl, 'https://login.microsoftonline.com/tenant/oauth2/v2.0/token');
});

test('a command line gives the same provider settings everywhere', () => {
  const graph = { kind: 'graph-app-folder', tenantId: 't', clientId: 'c' };
  assert.deepEqual(parseProvider(['graph-app-folder', 't', 'c']), { ...graph, folder: { type: 'personal' } });
  assert.deepEqual(parseProvider(['graph-app-folder', 't', 'c', 'drive', 'x', 'http://localhost:1234']),
    { ...graph, folder: { type: 'drive', driveId: 'x' }, redirectUri: 'http://localhost:1234' });
  assert.deepEqual(parseProvider(['graph-app-folder', 't', 'c', 'site', 's']), { ...graph, folder: { type: 'site', siteId: 's' } });
  assert.deepEqual(parseProvider(['graph-app-folder', 't', 'c', 'http://localhost:1']), { ...graph, folder: { type: 'personal' }, redirectUri: 'http://localhost:1' });
  assert.throws(() => parseProvider(['graph-app-folder', 't', 'c', 'drive']), /drive's id/);
  assert.equal(providerLabel(parseProvider(['graph-app-folder', 't', 'c', 'site', 's'])), 'SharePoint (site s)');
  assert.deepEqual(parseProvider(['folder', 'here'], path => `/abs/${path}`), { kind: 'folder', path: '/abs/here' });
  assert.deepEqual(parseProvider(['dropbox']), { kind: 'dropbox' });
  assert.throws(() => parseProvider(['graph-app-folder', 't']), /tenant id and a client id/);
  assert.throws(() => parseProvider(['ftp']), /dropbox, folder or graph-app-folder/);
  assert.equal(signalingFor({ kind: 'folder', path: '/tmp' }, () => { throw new Error('a folder has no token'); }).needsPerson(new Error('x')), false);
});

test('hosts signaling through a Graph App folder see each other, and connect', { timeout: 30_000 }, async () => {
  const root = '/drives/b!team/special/approot';
  const graph = fakeGraph(root);
  const realFetch = globalThis.fetch;
  globalThis.fetch = graph.fetch as typeof fetch;
  const hosts: RtcHost<unknown>[] = [];
  try {
    // the first token is refused, as an expired one would be - asked again
    // with retry, it's refreshed
    const tokens: boolean[] = [];
    const getToken = async (retry: boolean) => {
      tokens.push(retry);
      if (retry) graph.refuseNoMore();
      return retry ? 'fresh-token' : 'stale-token';
    };
    const signaling = () => graphAppFolderSignaling(getToken, { type: 'drive', driveId: 'b!team' });
    const a = createRtcHost(signaling(), {
      deviceId: 'a', name: 'A', iceServers: [],
      accept: channel => void channel.pipe.onMessage(text => channel.pipe.send(`a heard ${text}`)),
    });
    const b = createRtcHost(signaling(), { deviceId: 'b', name: 'B', iceServers: [] });
    hosts.push(a, b);

    await new Promise<void>(resolve => {
      const seen = (devices: Record<string, Device<unknown>>) => devices.a?.online && resolve();
      b.onDevices(seen);
      seen(b.devices);
    });
    const link = await b.connect('a');
    const channel = await link.open('hello');
    const reply = new Promise<string>(resolve => channel.pipe.onMessage(resolve));
    channel.pipe.send('b');
    assert.equal(await reply, 'a heard b');
    link.close();

    assert.ok(tokens.includes(true), 'a refused token was refreshed');
    assert.ok(graph.files.has('devices/a.json') && graph.files.has('devices/b.json'));
    assert.ok(graph.calls.every(call => call.includes(`${root}:/`)), 'everything stays in the App folder');
  } finally {
    await Promise.all(hosts.map(host => host.stop({ offline: false })));
    globalThis.fetch = realFetch;
  }
});
