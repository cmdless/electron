# @cmdless/rtc-sdk

Devices that find each other and connect over WebRTC, in node or the browser. Each is an **RTC host**: it advertises itself, keeps up with the other devices, answers whoever connects to it, and connects to them. How they reach each other to set that up — their advertisements, and WebRTC's offer and answer for each connection — is carried by a **provider** you choose. Hosts on the same provider see each other.

```ts
import { createRtcHost, folderSignaling } from '@cmdless/rtc-sdk/node';

const host = createRtcHost(folderSignaling('/Users/me/OneDrive/team'), {
  deviceId: 'alice',
  name: 'Alice',
  info: { role: 'reviewer' },                     // anything, for the others to read
  accept: channel => {                             // each channel another device opens
    if (channel.label !== 'my-protocol') return false;
    myProtocol.accept(configure)(channel.connection()).listen();
  },
});

host.onDevices(devices => { /* { bob: { name, online, updatedAt, iceServers, info } } */ });
const link = await host.connect('bob');
const client = myProtocol.createClient((await link.open('my-protocol')).connection());
```

## Hosts

`createRtcHost(provider, options)` — from `/node` (WebRTC by [node-datachannel](https://github.com/murat-dogan/node-datachannel)'s standard `RTCPeerConnection`, over libdatachannel — prebuilt for each platform, nothing built or run at install) or `/browser` (the browser's own). A browser tab is as much a host as anything else, for as long as it's open. `createHost(webrtc, provider, options)` takes any other WebRTC behind the small `WebRtc` interface.

- `deviceId`, `name`, `info`, `iceServers` (STUN by default) and `heartbeatSeconds` (60) are what it advertises; `update({ ... })` changes any of them. A device that misses three heartbeats shows as offline, and one that stops cleanly is marked offline straight away.
- `accept` gets every channel another device opens: its `label`, who it's `from` (as that device said — the provider's own trust is all that vouches for it), its `pipe` of whole messages, and `connection()` — the pipe as a JSON-RPC connection for any [`@cmdless/rpc-sdk`](../rpc-sdk) protocol. Returning `false` (or throwing) refuses it, and the side that opened it sees `open` fail. Without `accept`, the host answers no one.
- `publish: false` watches and connects without being seen.
- `connect(deviceId)` gives a link to open channels on — as many as you like — and `onClose`, called once when it's gone from either side.
- `onError` hears failures it's waiting out (and `undefined` once it's caught up); `onStopped` one only a person can get past, like a refused sign-in, after which the host has stopped.
- `stop()` closes every connection and marks the device offline.

## Providers

- `memorySignaling()` — within one process: hosts that share one see each other, nothing else does. For tests, and hosts side by side.
- `folderSignaling(path)` (`/node`) — a folder every device can write to, such as one a sync client keeps in step across machines. No account: whoever can write the folder is in the group. Changes are noticed by the OS's file events, so a network share that sends none won't do.
- `dropboxSignaling(getToken)` — a Dropbox app's own App folder: devices signed in to the same Dropbox account through the same app. `dropboxApp(appKey?, redirectUri?)` is the OAuth app to sign in with — cmdless's own, or yours with one of its registered redirect URIs.

They all lay it out the same way — `devices/<deviceId>.json`, and `signal/<deviceId>/<sessionId>.offer.json` with its `.answer.json` — through `fileSignaling(files, needsPerson)`, which builds a provider on any store of files. A provider that isn't files implements `SignalingProvider` itself: publish and watch advertisements, answer offers, send one and wait for its answer.

## Connections

ICE isn't trickled: each side gathers its candidates first, so a connection is one message each way through the provider — a few seconds through a synced folder is fine. Devices on one network connect directly by their local addresses; across networks STUN finds a way through most NATs, and where both ends are behind strict ones, a TURN server (in `iceServers`) has to relay.
