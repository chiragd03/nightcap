import { useCallback, useEffect, useState, type CSSProperties, type FormEvent } from 'react'
import { households, join } from '../api'
import Icon from '../components/Icon'
import './Profiles.css' // the Who's watching look
import { errorWords } from '../errors'
import './Setup.css'

// First run on this browser: join a household, as a TV does on its Connect screen. A server at
// home lists its households to pick from; one that asks for a code (any on the internet) takes
// the household's join code, which its admin has.

const MARK = `${import.meta.env.BASE_URL}brand/mark.png`
const HOUSEHOLD_TINT = '#4A3A78'
const CODE_TINT = '#24506A'

export default function Setup() {
  const [info, setInfo] = useState<Awaited<ReturnType<typeof households>>>()
  const [error, setError] = useState<string>()
  // (Couldn't ask which households there are: said, with Try again.)
  const [unreached, setUnreached] = useState<unknown>()
  const [typing, setTyping] = useState(false)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [glow, setGlow] = useState(HOUSEHOLD_TINT)

  const ask = useCallback(() => {
    setUnreached(undefined)
    households().then(i => { setInfo(i); setTyping(i.codeRequired || !i.households.length) }, setUnreached)
  }, [])
  useEffect(ask, [ask])
  // (Asked again by itself when the connection comes back, or the tab is shown again.)
  useEffect(() => {
    if (!unreached) return
    const again = () => { if (document.visibilityState === 'visible') ask() }
    addEventListener('online', again)
    document.addEventListener('visibilitychange', again)
    return () => { removeEventListener('online', again); document.removeEventListener('visibilitychange', again) }
  }, [unreached, ask])

  const go = async (how: { household: string } | { code: string }) => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    try {
      await join(how) // the app moves on by itself once this browser has its key
    } catch (e) {
      setError(errorWords(e))
      setBusy(false)
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const typed = code.replace(/[\s-]/g, '').toUpperCase()
    if (!typed) return setError("Type the household's join code.")
    go({ code: typed })
  }

  // Back from the code box to the households, when there are any to pick from.
  const canGoBack = typing && info && !info.codeRequired && info.households.length > 0
  const back = () => { setTyping(false); setError(undefined) }
  useEffect(() => {
    if (!canGoBack) return
    const key = (e: KeyboardEvent) => e.key === 'Escape' && back()
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [canGoBack])

  const server = info?.server ?? 'Nightcap'
  return (
    <div className="who" style={{ '--glow': glow } as CSSProperties}>
      <div className="who-aura" aria-hidden />
      {canGoBack && (
        <button className="setup-back-round" aria-label="Back to households" onClick={back}><Icon name="chevron" size={22} /></button>
      )}
      <div className="who-content">
        <img className="setup-mark" src={MARK} alt="Nightcap" />
        <h1>{typing ? 'Join code' : 'Which household?'}</h1>
        <p className="setup-lead">
          {!info ? (unreached ? errorWords(unreached) : 'Looking for households…')
            : typing ? `${server} asks for your household's join code. The household's admin has it.`
            : `This browser joins one household on ${server}.`}
        </p>
        {!info && !!unreached && <button className="btn primary setup-retry" onClick={ask}>Try again</button>}
        {/* Where the server runs is set when it's deployed: shown, never changed here. */}
        {info && <span className="setup-mode">{info.mode === 'home' ? 'Home server · on your network' : 'Cloud server · joins with a code'}</span>}

        {info && !typing && (
          <div className="setup-tiles">
            {info.households.map((h, i) => (
              <button key={h.id} className="setup-tile" style={{ '--i': i } as CSSProperties} disabled={busy}
                onMouseEnter={() => setGlow(HOUSEHOLD_TINT)} onFocus={() => setGlow(HOUSEHOLD_TINT)} onClick={() => go({ household: h.id })}>
                <span className="setup-tile-icon"><Icon name="nav_home" size={22} /></span>
                <span className="eyebrow">Household</span>
                <span className="setup-tile-name">{h.name}</span>
                <span className="setup-tile-sub">{busy ? 'Joining…' : 'Join'}</span>
              </button>
            ))}
            <button className="setup-tile" style={{ '--i': info.households.length } as CSSProperties}
              onMouseEnter={() => setGlow(CODE_TINT)} onFocus={() => setGlow(CODE_TINT)} onClick={() => setTyping(true)}>
              <span className="setup-tile-icon"><Icon name="add" size={22} /></span>
              <span className="eyebrow">Another household</span>
              <span className="setup-tile-name">Join code</span>
              <span className="setup-tile-sub">Type the code its admin gave you</span>
            </button>
          </div>
        )}

        {info && typing && (
          <form className="setup glass" onSubmit={submit}>
            <input
              value={code}
              onChange={e => setCode(e.target.value.toUpperCase())}
              placeholder="ABCD 2345"
              aria-label="Join code"
              maxLength={20}
              autoComplete="off"
              spellCheck={false}
              autoFocus
            />
            <button className="btn primary" disabled={busy}>{busy ? 'Joining…' : 'Join'}</button>
            {canGoBack && <button type="button" className="setup-back" onClick={back}>Pick a household instead</button>}
          </form>
        )}

        {info && error && <p className="setup-error">{error}</p>}
        <a className="setup-owner" href={`${import.meta.env.BASE_URL}server`}>Server owner</a>
      </div>
    </div>
  )
}
