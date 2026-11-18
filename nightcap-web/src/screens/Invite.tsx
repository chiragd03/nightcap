import { useState, type CSSProperties, type FormEvent } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { device, join, profile } from '../api'
import './Profiles.css' // the Who's watching look
import './Setup.css'
import { useLimitsReady } from '../limits'
import WithLimits from '../components/WithLimits'
import { ApiError, errorWords, isOffline } from '../errors'

// An invite link (/join#{code}), made by the server's owner: this browser joins that household
// with the code, then asks who's watching. A browser already in a household switches to this one.
// The code is after # so it never reaches the server's logs; it joins one device, once, within 24 hours. A link without
// it (a short link drops what's after #, say) asks for the code instead, in the same big box.

const MARK = `${import.meta.env.BASE_URL}brand/mark.png`

function InviteScreen() {
  const lim = useLimitsReady()
  const fromLink = decodeURIComponent(useLocation().hash.slice(1))
  const [code, setCode] = useState(fromLink)
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const already = device.get() != null
  const shown = code.toUpperCase().replace(/[^A-Z0-9]/g, '')

  const go = async (e?: FormEvent) => {
    e?.preventDefault()
    if (busy || shown.length < lim.inviteCodeLength) return
    setBusy(true)
    setError(undefined)
    try {
      profile.forget()
      await join({ code: shown })
      navigate('/profiles', { replace: true })
    } catch (e) {
      // (Too many tries, or no connection: said as such; anything else is the invite.)
      setError(isOffline(e) || (e instanceof ApiError && (e.status === 429 || e.status >= 500)) ? errorWords(e)
        : "That invite doesn't work: each one lets one device join, once, within 24 hours. Ask for a new one.")
      setBusy(false)
    }
  }

  return (
    <div className="who" style={{ '--glow': '#4A3A78' } as CSSProperties}>
      <div className="who-aura" aria-hidden />
      <div className="who-content">
        <img className="setup-mark" src={MARK} alt="Nightcap" />
        <h1>You're invited</h1>
        <p className="setup-lead">
          This joins a household on Nightcap: its profiles, what they watch, and what's on its TVs.
          {already && ' This browser is in a household already; joining this one switches it.'}
        </p>
        <form className="invite-form" onSubmit={go}>
          {!fromLink && <p className="setup-lead invite-ask">Type the invite code you were given.</p>}
          <input className="invite-code" aria-label="Invite code" placeholder="ABCD 2345" maxLength={lim.inviteCodeLength + 4}
            value={shown.length > 4 ? `${shown.slice(0, 4)} ${shown.slice(4)}` : shown}
            onChange={e => setCode(e.target.value)} autoFocus={!fromLink} readOnly={!!fromLink && busy}
            autoComplete="off" autoCapitalize="characters" spellCheck={false} />
          <button className="btn primary invite-go" disabled={busy || shown.length < lim.inviteCodeLength}>{busy ? 'Joining…' : 'Join the household'}</button>
        </form>
        {already && <button className="setup-back" onClick={() => navigate('/', { replace: true })}>Not now</button>}
        {error && <p className="setup-error">{error}</p>}
      </div>
    </div>
  )
}

/** (It waits for the server's limits: names, the PIN, how many.) */
export default function Invite() {
  return <WithLimits><InviteScreen /></WithLimits>
}
