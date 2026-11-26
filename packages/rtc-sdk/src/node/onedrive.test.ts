import test from 'node:test';
import assert from 'node:assert/strict';
import { createRtcHost, oneDriveApp, oneDriveBase, oneDriveSignaling, parseProvider, signalingFor } from './index.js';
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

test('a OneDrive base is the item it starts from and the folder under it', () => {
  assert.deepEqual(oneDriveBase(), { root: '/me/drive/special/approot', folder: '', appFolder: true });
  assert.deepEqual(oneDriveBase('/sites/contoso.sharepoint.com,1,2/drive/root:/gh-approvals:'), { root: '/sites/contoso.sharepoint.com,1,2/drive/root', folder: 'gh-approvals', appFolder: false });
  assert.deepEqual(oneDriveBase('/drives/b!abc/root:/team/signal/'), { root: '/drives/b!abc/root', folder: 'team/signal', appFolder: false });
  assert.throws(() => oneDriveBase('drives/x'));
  // the App folder asks only for itself; anywhere else, for the user's files
  assert.deepEqual(oneDriveApp('tenant', 'client').scopes, ['Files.ReadWrite.AppFolder', 'offline_access']);
  assert.deepEqual(oneDriveApp('tenant', 'client', '/drives/x/root:/y').scopes, ['Files.ReadWrite.All', 'offline_access']);
  assert.equal(oneDriveApp('tenant', 'client').tokenUrl, 'https://login.microsoftonline.com/tenant/oauth2/v2.0/token');
});

test('a command line gives the same provider settings everywhere', () => {
  assert.deepEqual(parseProvider(['onedrive', 't', 'c']), { kind: 'onedrive', tenantId: 't', clientId: 'c' });
  assert.deepEqual(parseProvider(['onedrive', 't', 'c', '/drives/x/root:/y', 'http://localhost:1234']),
    { kind: 'onedrive', tenantId: 't', clientId: 'c', base: '/drives/x/root:/y', redirectUri: 'http://localhost:1234' });
  assert.deepEqual(parseProvider(['folder', 'here'], path => `/abs/${path}`), { kind: 'folder', path: '/abs/here' });
  assert.deepEqual(parseProvider(['dropbox']), { kind: 'dropbox' });
  assert.throws(() => parseProvider(['onedrive', 't']), /tenant id and a client id/);
  assert.throws(() => parseProvider(['ftp']), /dropbox, folder or onedrive/);
  assert.equal(signalingFor({ kind: 'folder', path: '/tmp' }, () => { throw new Error('a folder has no token'); }).needsPerson(new Error('x')), false);
});

test('hosts signaling through a OneDrive folder see each other, and connect', { timeout: 30_000 }, async () => {
  const root = '/drives/b!team/root';
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
    const signaling = () => oneDriveSignaling(getToken, `${root}:/signal:`);
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
    assert.ok(graph.files.has('signal/devices/a.json') && graph.files.has('signal/devices/b.json'));
    assert.ok(graph.calls.every(call => call.includes(`${root}:/signal/`)), 'everything stays under the base');
  } finally {
    await Promise.all(hosts.map(host => host.stop({ offline: false })));
    globalThis.fetch = realFetch;
  }
});
