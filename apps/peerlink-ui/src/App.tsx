import { useEffect, useMemo, useState } from 'react'
import { createBrowserAuth, NotSignedIn } from '@cmdless/auth-sdk/browser'
import { createDropbox, dropboxApp, watchDevices } from '@cmdless/peerlink-sdk'
import type { Device } from '@cmdless/peerlink-sdk'

// the same Dropbox app the daemons use, signed in to from this page, which
// is also where Dropbox sends the sign-in back to
const auth = createBrowserAuth({ ...dropboxApp, redirectUri: `${window.location.origin}/` })

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
    const dropbox = createDropbox(async retry => {
      if (retry) auth.expire()
      return auth.getToken()
    })
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

function DeviceRow({ device }: { device: Device }) {
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
              <button disabled title="Connecting comes with WebRTC">Connect</button>
            </li>
          ))}
        </ul>
      )}
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
      {sorted.map(([deviceId, device]) => <DeviceRow key={deviceId} device={device} />)}
    </main>
  )
}

export default App
