import { useEffect, useRef, useState } from 'react'
import * as api from '../api'
import { errorWords } from '../errors'
import './PlayOnTv.css'

// Play on TV: pick one of the household's TVs (skipped when there's only one), send it the title
// or link, then follow what becomes of it. The TV asks whoever is there; a title plays as this
// profile (the TV switches to it), a link on the TV's own profile. A TV that's off or asleep is
// said at once; one that doesn't pick it up soon is "unreachable" (the server decides both).

const CHECK_MS = 2000

type Props = { what: api.PlayWhat; name: string; onClose: () => void }

type State =
  | { step: 'choose' }
  | { step: 'sending' | 'waiting' | 'shown'; tv: api.Device; request?: number }
  | { step: 'done'; tv: api.Device; status: 'accepted' | 'declined' | 'unreachable' | 'off' | 'failed'; error?: string }

const DONE_WORDS = {
  accepted: (tv: string) => [`Playing on ${tv}`, 'Enjoy.'],
  declined: (tv: string) => [`${tv} said no`, 'Whoever is at the TV turned it down, or nobody answered.'],
  unreachable: (tv: string) => [`${tv} didn't answer`, 'It may be off, asleep or out of reach.'],
  off: (tv: string) => [`${tv} is off`, "It hasn't been used for a few minutes. Turn it on and try again."],
  failed: (tv: string) => [`Couldn't send to ${tv}`, ''],
} as const

export default function PlayOnTv({ what, name, onClose }: Props) {
  const [tvs, setTvs] = useState<api.Device[]>()
  // (The household's TVs couldn't be asked for: said, with Try again; not "there's no TV".)
  const [unreached, setUnreached] = useState<unknown>()
  const [tries, setTries] = useState(0)
  const [state, setState] = useState<State>({ step: 'choose' })
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  useEffect(() => {
    setUnreached(undefined)
    api.devices().then(list => {
      // Each TV once: an older entry left from before it joined again isn't offered.
      const old = api.leftovers(list)
      const found = list.filter(d => api.deviceKind(d) === 'tv' && !old.has(d.id))
      setTvs(found)
      if (found.length === 1) send(found[0])
    }, setUnreached)
  }, [tries])

  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])

  const send = async (tv: api.Device) => {
    setState({ step: 'sending', tv })
    try {
      const r = await api.playOnTv(tv.id, what)
      if (!alive.current) return
      setState({ step: 'waiting', tv, request: r.request })
      follow(tv, r.request)
    } catch (e) {
      if (!alive.current) return
      setState({ step: 'done', tv, status: e instanceof api.TvOff ? 'off' : 'failed', error: e instanceof api.TvOff ? undefined : errorWords(e) })
    }
  }

  // Checked every couple of seconds until it's no longer waiting or showing on the TV.
  const follow = (tv: api.Device, request: number) => {
    // (The server not answering for half a minute: said, rather than asked forever.)
    let misses = 0
    const check = () => api.playStatus(request).then(status => {
      if (!alive.current) return
      misses = 0
      if (status === 'waiting' || status === 'shown') {
        setState({ step: status, tv, request })
        setTimeout(check, CHECK_MS)
      } else setState({ step: 'done', tv, status })
    }, e => {
      if (!alive.current) return
      if (++misses * CHECK_MS < 30_000) setTimeout(check, CHECK_MS)
      else setState({ step: 'done', tv, status: 'failed', error: errorWords(e) })
    })
    setTimeout(check, CHECK_MS)
  }

  let body
  if (state.step === 'choose') {
    body = !tvs && unreached ? <><p className="pot-line">{errorWords(unreached)}</p><button className="btn primary" onClick={() => setTries(n => n + 1)}>Try again</button></>
      : !tvs ? <p className="pot-line">Looking for TVs…</p>
      : tvs.length === 0 ? <p className="pot-line">There's no TV in this household yet. A TV joins from its Connect screen.</p>
      : (
        <div className="pot-tvs">
          {tvs.map(tv => (
            <button key={tv.id} className="pot-tv" onClick={() => send(tv)}>
              <TvMark />
              <span><b>{tv.name}</b><small>{tv.lastUsed ? `Used ${ago(tv.lastUsed)}` : 'Not used since it joined'}</small></span>
            </button>
          ))}
        </div>
      )
  } else if (state.step === 'done') {
    const [head, line] = DONE_WORDS[state.status](state.tv.name)
    body = (
      <div className={`pot-status ${state.status === 'accepted' ? 'good' : 'bad'}`}>
        <span className="pot-icon">{state.status === 'accepted' ? '✓' : '✕'}</span>
        <b>{head}</b>
        {(line || state.error) && <span>{line || state.error}</span>}
        <div className="pot-buttons">
          {state.status !== 'accepted' && <button className="btn" onClick={() => send(state.tv)}>Try again</button>}
          <button className="btn primary" onClick={onClose}>Done</button>
        </div>
      </div>
    )
  } else {
    body = (
      <div className="pot-status">
        <span className="pot-pulse"><TvMark /></span>
        <b>{state.step === 'shown' ? `Asking on ${state.tv.name}…` : state.step === 'waiting' ? `Waiting for ${state.tv.name}…` : `Sending to ${state.tv.name}…`}</b>
        <span>{state.step === 'shown' ? 'Whoever is at the TV says yes or no.' : 'The TV picks it up within a few seconds.'}</span>
      </div>
    )
  }

  return (
    <div className="pot-scrim" onClick={onClose}>
      <div className="pot glass" role="dialog" aria-label="Play on TV" onClick={e => e.stopPropagation()}>
        <span className="eyebrow">Play on TV</span>
        <h3>{name}</h3>
        {body}
        {state.step === 'choose' && <button className="pot-cancel" onClick={onClose}>Cancel</button>}
      </div>
    </div>
  )
}

const TvMark = () => (
  <span className="pot-mark" aria-hidden>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="5" width="18" height="12" rx="2" /><path d="M8 20h8M12 17v3" />
    </svg>
  </span>
)

function ago(iso: string) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 90) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} minutes ago`
  if (s < 86400) return `${Math.round(s / 3600)} hours ago`
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}
