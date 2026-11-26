import { useEffect, useMemo, useState } from 'react'
import { createBrowserAuth, NotSignedIn } from '@cmdless/auth-sdk/browser'
import { createRtcHost, dropboxApp, dropboxSignaling } from '@cmdless/rtc-sdk/browser'
import type { Device, RtcHost } from '@cmdless/rtc-sdk/browser'
import type { AdvertisedOffer, LinkTarget, PeerlinkInfo } from '@cmdless/peerlink-sdk'
import { hangarProtocol } from '@cmdless/hangar-sdk'
import type { AgentsState, HostState } from '@cmdless/hangar-sdk'

// the same Dropbox app the daemons use, signed in to from this page, which
// is also where Dropbox sends the sign-in back to
const auth = createBrowserAuth({ ...dropboxApp(), redirectUri: `${window.location.origin}/` })
const signaling = dropboxSignaling(async retry => {
  if (retry) auth.expire()
  return auth.getToken()
}, reason => reason instanceof NotSignedIn)

type PeerlinkDevice = Device<PeerlinkInfo>
const offersOf = (device: PeerlinkDevice) => Object.values(device.info?.offers ?? {})

function ago(iso: string) {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`
  return `${Math.round(seconds / 86400)}d ago`
}

// this page as a device of its own, while signed in: it watches the others
// and connects to them, without being listed or answering anyone
function useHost(signedIn: boolean, signedOut: (reason: string) => void) {
  const [host, setHost] = useState<RtcHost<PeerlinkInfo>>()
  const [devices, setDevices] = useState<Record<string, PeerlinkDevice>>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    if (!signedIn) return
    const started = createRtcHost<PeerlinkInfo>(signaling, {
      deviceId: `peerlink-ui-${crypto.randomUUID()}`,
      name: 'peerlink-ui',
      publish: false,
      onDevices: setDevices,
      onError: reason => setError(reason),
      onStopped: signedOut,
    })
    setHost(started)
    return () => { void started.stop() }
  }, [signedIn, signedOut])

  return { host, devices, error }
}

// a live look at a hangar on another device, through peerlink: its host
// state and agents, read over the hangar offer's own protocol
function HangarView({ host: rtc, deviceId, offer }: { host: RtcHost<PeerlinkInfo>; deviceId: string; offer: AdvertisedOffer }) {
  const [phase, setPhase] = useState('Connecting through Dropbox…')
  const [host, setHost] = useState<HostState>()
  const [agents, setAgents] = useState<AgentsState>()

  useEffect(() => {
    let closed = false
    let close = () => { }
    ;(async () => {
      const link = await rtc.connect(deviceId)
      close = link.close
      if (closed) return close()
      link.onClose(() => setPhase('Disconnected'))
      setPhase('Opening hangar…')
      const target: LinkTarget = { offerId: offer.id }
      const hangar = hangarProtocol.createClient((await link.open(JSON.stringify(target))).connection())
      hangar.listen()
      await hangar.checkVersion()
      await hangar.state.host.subscribe(setHost)
      await hangar.state.agents.subscribe(setAgents)
      setPhase('Connected')
    })().catch(reason => setPhase(`Couldn't connect: ${reason?.message ?? reason}`))
    return () => { closed = true; close() }
  }, [rtc, deviceId, offer.id])

  return (
    <div className="view">
      <p className="muted">{phase}</p>
      {host && (
        // addresses carry tokens, so they aren't shown
        <dl>
          <dt>status</dt><dd>{host.status}{host.stale ? ' (restart to apply agent changes)' : ''}</dd>
          <dt>instance</dt><dd>{host.instanceId.slice(0, 8)}</dd>
          <dt>registry</dt><dd>{host.registry.status}</dd>
          <dt>agents</dt><dd>Claude (built in){Object.keys(agents ?? {}).map(id => `, ${id}`).join('')}</dd>
        </dl>
      )}
    </div>
  )
}

function DeviceRow({ host, deviceId, device }: { host: RtcHost<PeerlinkInfo>; deviceId: string; device: PeerlinkDevice }) {
  const [open, setOpen] = useState<string>()
  const offers = offersOf(device)
  return (
    <section className={`device ${device.online ? 'online' : 'offline'}`}>
      <div>
        <span className="dot" />
        <strong>{device.name}</strong>
        <span className="muted">{device.online ? 'online' : 'offline'} · seen {ago(device.updatedAt)}</span>
      </div>
      {offers.length > 0 && (
        <ul>
          {offers.map(offer => (
            <li key={offer.id}>
              <span className="kind">{offer.kind}</span>
              <span>{offer.name}</span>
              {offer.kind === 'hangar' && (
                <button
                  disabled={!device.online}
                  onClick={() => setOpen(open === offer.id ? undefined : offer.id)}
                >
                  {open === offer.id ? 'Disconnect' : 'Connect'}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {offers.filter(offer => offer.id === open).map(offer =>
        <HangarView key={offer.id} host={host} deviceId={deviceId} offer={offer} />)}
    </section>
  )
}

function App() {
  const [signedIn, setSignedIn] = useState(auth.signedIn)
  const [problem, setProblem] = useState<string>()
  const [, tick] = useState(0)

  // coming back from Dropbox's sign-in
  useEffect(() => {
    auth.completeSignIn()
      .then(completed => { if (completed) setSignedIn(true) })
      .catch(reason => setProblem(String(reason?.message ?? reason)))
  }, [])

  // keeps "seen 12s ago" moving
  useEffect(() => {
    const timer = setInterval(() => tick(n => n + 1), 5_000)
    return () => clearInterval(timer)
  }, [])

  const signedOut = useMemo(() => (reason: string) => { setSignedIn(false); setProblem(reason) }, [])
  const { host, devices, error } = useHost(signedIn, signedOut)

  const sorted = Object.entries(devices ?? {}).sort(([, a], [, b]) =>
    Number(b.online) - Number(a.online) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt))

  return (
    <main>
      <header>
        <strong>peerlink</strong>
        {signedIn
          ? <button onClick={() => { auth.signOut(); setSignedIn(false) }}>Sign out</button>
          : <button onClick={() => auth.signIn()}>Sign in with Dropbox</button>}
      </header>
      {problem && <p className="error">{problem}</p>}
      {error && <p className="error">{error}</p>}
      {!signedIn && <p className="muted empty">Sign in to the Dropbox account your devices use to see them here.</p>}
      {signedIn && !devices && <p className="muted empty">Looking for devices…</p>}
      {signedIn && devices && sorted.length === 0 && <p className="muted empty">No devices yet. Start peerlink on one, and sign it in to this Dropbox account.</p>}
      {host && sorted.map(([deviceId, device]) => <DeviceRow key={deviceId} host={host} deviceId={deviceId} device={device} />)}
    </main>
  )
}

export default App
