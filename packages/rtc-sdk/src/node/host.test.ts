import test from 'node:test';
import assert from 'node:assert/strict';
import { defineProtocol } from '@cmdless/rpc-sdk';
import { createRtcHost, memorySignaling } from './index.js';
import type { Device, RtcHost } from './index.js';

const iceServers: never[] = [];

const until = <T>(host: RtcHost<T>, ready: (devices: Record<string, Device<T>>) => boolean) =>
  new Promise<Record<string, Device<T>>>(resolve => {
    if (ready(host.devices)) return resolve(host.devices);
    const stop = host.onDevices(devices => {
      if (!ready(devices)) return;
      stop();
      resolve(devices);
    });
  });

const echo = defineProtocol(({ side, request }) => ({
  name: 'echo',
  clientToServer: side({ requests: { shout: request<{ text: string }, { text: string; from: string }>('shout') } }),
}));

test('hosts on one provider see each other, and connect', async () => {
  const provider = memorySignaling();
  const accepted: string[] = [];
  const a = createRtcHost(provider, {
    deviceId: 'a', name: 'Device A', iceServers, info: { color: 'blue' },
    accept: channel => {
      accepted.push(`${channel.label} from ${channel.from}`);
      if (channel.label === 'echo') {
        echo.accept(server => server.onRequest.shout(({ text }) => ({ text: text.toUpperCase(), from: channel.from })))(channel.connection()).listen();
        return;
      }
      if (channel.label === 'raw') return void channel.pipe.onMessage(text => channel.pipe.send(`raw: ${text}`));
      return false;
    },
  });
  const b = createRtcHost(provider, { deviceId: 'b', name: 'Device B', iceServers });

  try {
    const seen = await until(b, devices => !!devices.a?.online);
    assert.equal(seen.a.name, 'Device A');
    assert.deepEqual(seen.a.info, { color: 'blue' });
    await until(a, devices => !!devices.b);

    const link = await b.connect('a');
    // JSON-RPC over a channel
    const client = echo.createClient((await link.open('echo')).connection());
    client.listen();
    assert.deepEqual(await client.request.shout({ text: 'hi' }), { text: 'HI', from: 'b' });

    // whole messages, however big
    const raw = await link.open('raw');
    const big = 'x'.repeat(100_000);
    const reply = new Promise<string>(resolve => raw.pipe.onMessage(resolve));
    raw.pipe.send(big);
    assert.equal(await reply, `raw: ${big}`);

    // a label accept turns down is closed
    await assert.rejects(link.open('nope'));
    assert.deepEqual(accepted, ['echo from b', 'raw from b', 'nope from b']);

    // info changes are seen
    a.update({ info: { color: 'green' } });
    await until(b, devices => (devices.a?.info as { color: string })?.color === 'green');

    // a stopping is seen as offline, and its connections close
    const closed = new Promise<void>(resolve => link.onClose(resolve));
    await a.stop();
    await until(b, devices => devices.a?.online === false);
    await closed;
  } finally {
    await a.stop();
    await b.stop();
  }
});

test('a host that publishes nothing still sees and connects, unseen', async () => {
  const provider = memorySignaling();
  const a = createRtcHost(provider, {
    deviceId: 'a', name: 'A', iceServers,
    accept: channel => void channel.pipe.onMessage(text => channel.pipe.send(text)),
  });
  const watcher = createRtcHost(provider, { deviceId: 'w', name: 'W', iceServers, publish: false });
  try {
    await until(watcher, devices => !!devices.a);
    const link = await watcher.connect('a');
    const channel = await link.open('x');
    const back = new Promise<string>(resolve => channel.pipe.onMessage(resolve));
    channel.pipe.send('ping');
    assert.equal(await back, 'ping');
    assert.deepEqual(Object.keys(a.devices), []);
    link.close();
  } finally {
    await a.stop();
    await watcher.stop();
  }
});

test('a host that accepts nothing never answers', async () => {
  const provider = memorySignaling();
  const a = createRtcHost(provider, { deviceId: 'a', name: 'A', iceServers });
  const b = createRtcHost(provider, { deviceId: 'b', name: 'B', iceServers });
  try {
    await assert.rejects(b.connect('a', { answerTimeoutMs: 500 }), /timed out/);
  } finally {
    await a.stop();
    await b.stop();
  }
});
