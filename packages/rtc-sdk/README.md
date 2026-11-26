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
- `oneDriveSignaling(getToken, base?)` — a OneDrive or SharePoint folder, through Microsoft Graph, given as a Graph path: the App folder (`/me/drive/special/approot`, the default) for one user's devices, or a folder everyone given access to it can reach — `/sites/{siteId}/drive/root:/{folder}` in a site's library, or `/drives/{driveId}/root:/{folder}` in any drive. `oneDriveApp(tenantId, clientId, base?, redirectUri?)` is the Entra app to sign in with: a public client with the Mobile and desktop platform (redirect `http://localhost` unless you give another), asking for `Files.ReadWrite.AppFolder` for the App folder, or `Files.ReadWrite.All` elsewhere — which some tenants only allow with an admin's consent. Graph has no long poll, so each watched folder is listed every three seconds, and a connection takes a few seconds to set up.

`getToken(retry)` is asked before every call, and again with `retry` when the provider refuses a token, so whatever holds the sign-in can refresh it; rtc-sdk never signs in itself. [`@cmdless/auth`](../../apps/auth)'s broker does, for the daemons.

They all lay it out the same way — `devices/<deviceId>.json`, and `signal/<deviceId>/<sessionId>.offer.json` with its `.answer.json` — through `fileSignaling(files, needsPerson)`, which builds a provider on any store of files. A provider that isn't files implements `SignalingProvider` itself: publish and watch advertisements, answer offers, send one and wait for its answer.

## Provider settings

What an app keeps in its config to say which provider it uses — the same in every app, so they're all configured alike:

```ts
type ProviderSettings =
  | { kind: 'dropbox'; appKey?: string; redirectUri?: string }
  | { kind: 'folder'; path: string }
  | { kind: 'onedrive'; tenantId: string; clientId: string; base?: string; redirectUri?: string };
```

- `parseProvider(args, resolve?)` reads one from a command line (`onedrive <tenant id> <client id> [<base> [<redirect URI>]]`, and so on), and `providerUsage(command)` is the usage text for it.
- `validProvider`, `providerName` (`OneDrive`) and `providerLabel` (`OneDrive (App folder)`).
- `accountOf(settings)` is the OAuth app its account is signed in to — none for a folder.
- `signalingFor(settings, getToken)` (`/node`) is the provider itself; `accountSignaling` is the same without folders, for the browser.

## Connections

ICE isn't trickled: each side gathers its candidates first, so a connection is one message each way through the provider — a few seconds through a synced folder is fine. Devices on one network connect directly by their local addresses; across networks STUN finds a way through most NATs, and where both ends are behind strict ones, a TURN server (in `iceServers`) has to relay.
