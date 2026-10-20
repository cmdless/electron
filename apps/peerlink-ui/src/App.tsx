import { useEffect, useMemo, useState } from 'react'
import { createBrowserAuth, NotSignedIn } from '@cmdless/auth-sdk/browser'
import { createDropbox, dropboxApp, watchDevices } from '@cmdless/peerlink-sdk'
import type { AdvertisedOffer, Device } from '@cmdless/peerlink-sdk'
import { connectDevice } from '@cmdless/peerlink-sdk/browser'
import { hangarProtocol } from '@cmdless/hangar-sdk'
import type { AgentsState, HostState } from '@cmdless/hangar-sdk'

// the same Dropbox app the daemons use, signed in to from this page, which
// is also where Dropbox sends the sign-in back to
const auth = createBrowserAuth({ ...dropboxApp, redirectUri: `${window.location.origin}/` })
const dropbox = createDropbox(async retry => {
  if (retry) auth.expire()
  return auth.getToken()
})

function ago(iso: string) {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`
  return `${Math.round(seconds / 86400)}d ago`
}

function useDevices(signedIn: boolean, signedOut: (reason: string) => void) {
  const [devices, setDevices] = useState<Record<string, Device>>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    if (!signedIn) return
    const watch = watchDevices(dropbox, {
      onChange: setDevices,
      onReady: () => setError(undefined),
      onError: reason => {
        if (reason instanceof NotSignedIn) { signedOut(reason.message); return 'stop' }
        setError(String((reason as Error)?.message ?? reason))
        return 'retry'
      },
    })
    return () => watch.stop()
  }, [signedIn, signedOut])

  return { devices, error }
}

// a live look at a hangar on another device, through peerlink: its host
// state and agents, read over the hangar offer's own protocol
function HangarView({ deviceId, device, offer }: { deviceId: string; device: Device; offer: AdvertisedOffer }) {
  const [phase, setPhase] = useState('Connecting through Dropbox…')
  const [host, setHost] = useState<HostState>()
  const [agents, setAgents] = useState<AgentsState>()

  useEffect(() => {
    let closed = false
    let close = () => { }
    ;(async () => {
      const link = await connectDevice(dropbox, deviceId, { iceServers: device.iceServers })
      close = link.close
      if (closed) return close()
      link.onClose(() => setPhase('Disconnected'))
      setPhase('Opening hangar…')
      const hangar = hangarProtocol.createClient(await link.open({ offerId: offer.id }))
      hangar.listen()
      await hangar.state.host.subscribe(setHost)
      await hangar.state.agents.subscribe(setAgents)
      setPhase('Connected')
    })().catch(reason => setPhase(`Couldn't connect: ${reason?.message ?? reason}`))
    return () => { closed = true; close() }
  }, [deviceId, device.iceServers, offer.id])

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

function DeviceRow({ deviceId, device }: { deviceId: string; device: Device }) {
  const [open, setOpen] = useState<string>()
  const offers = Object.values(device.offers)
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
        <HangarView key={offer.id} deviceId={deviceId} device={device} offer={offer} />)}
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
  const { devices, error } = useDevices(signedIn, signedOut)

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
      {sorted.map(([deviceId, device]) => <DeviceRow key={deviceId} deviceId={deviceId} device={device} />)}
    </main>
  )
}

export default App
