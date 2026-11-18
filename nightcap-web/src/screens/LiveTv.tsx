import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import * as api from '../api'
import BackButton from '../components/BackButton'
import Icon from '../components/Icon'
import { useNotice } from '../components/Notice'
import Shelf from '../components/Shelf'
import { handler, opened, type Opened } from '../livetvHandler'
import { useSession } from '../session'
import Problem from '../components/Problem'
import Waiting from '../components/Waiting'
import { RowSkeleton } from '../components/RowView'
import { ApiError, errorWords, isOffline } from '../errors'
import { playerShown } from '../appUpdate'
import './TitlePage.css'
import './Player.css'
import './LiveTv.css'

// Live TV: channels from the household's own lists. The page is like
// Home: the channel pointed at on top, then the household's own rows (x-row), My channels and a row
// per kind, each ending in Browse all; a channel plays in a player of its own (LivePlayer).

// ---------- Cards ----------

/** "Live", "Soon · Thu 9:30 PM", "24/7" (a household's own item), or nothing (a plain channel). */
function stateLine(c: api.LiveCard) {
  if (c.state === 'live') return 'Live'
  if (c.state === '24/7') return '24/7'
  if (c.state === 'upcoming') return c.startsAt ? `Soon · ${when(c.startsAt)}` : 'Soon'
  return null
}

/** Upcoming and not on yet, until its start time: then it's tried (as the TV's player). */
const notYet = (c: api.LiveCard) => c.state === 'upcoming' && (c.startsAt ?? Infinity) > Date.now()

/** "Today 9:30 PM", "Tomorrow 3 PM", "Thu 3:30 PM", or, further off, "12 Dec, 5 PM". */
function when(ms: number) {
  const d = new Date(ms), now = new Date()
  const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86_400_000)
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: d.getMinutes() ? '2-digit' : undefined })
  if (days === 0) return `Today ${time}`
  if (days === 1) return `Tomorrow ${time}`
  if (days > 1 && days < 7) return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`
  return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}, ${time}`
}

/** A channel's picture: its logo on its tint, else its short name. */
function Art({ c, big }: { c: api.LiveCard; big?: boolean }) {
  const [broken, setBroken] = useState(false)
  return (
    <span className={`lv-art${big ? ' big' : ''}`} style={{ '--hue': c.hue } as CSSProperties}>
      {c.logo && !broken ? <img src={c.logo} alt="" loading="lazy" onError={() => setBroken(true)} /> : <b>{c.mono}</b>}
    </span>
  )
}

function LiveCardView({ c, onPeek, onOpen, onStar }: { c: api.LiveCard; onPeek: () => void; onOpen: () => void; onStar?: () => void }) {
  const line = stateLine(c)
  return (
    <div className={`lv-card-wrap${c.favourite ? ' fav' : ''}`}>
    <button className={`lv-card${c.state === 'upcoming' ? ' soon' : ''}`} onMouseEnter={onPeek} onFocus={onPeek} onClick={onOpen}>
      <span className="lv-tile">
        <Art c={c} />
        {line && <span className={`lv-badge ${c.state === 'live' ? 'live' : c.state === 'upcoming' ? 'soon' : ''}`}>{c.state === 'live' && <i aria-hidden />}{line}</span>}
        {c.channels && <span className="lv-count">{c.channels.length} channels</span>}
        {c.favourite && !onStar && <span className="lv-star" aria-label="In My channels"><Icon name="star" size={13} /></span>}
      </span>
      <span className="lv-name">{c.name}</span>
      <span className="lv-sub">{c.about ?? (c.kind === 'other' ? '' : c.kindName)}</span>
    </button>
    {/* (As the TV's long press: in or out of My channels, from the card itself.) */}
    {onStar && (
      <button className={`lv-star lv-star-btn${c.favourite ? ' on' : ''}`} onClick={onStar}
        aria-label={c.favourite ? `Take ${c.name} out of My channels` : `Add ${c.name} to My channels`}
        title={c.favourite ? 'In My channels' : 'Add to My channels'}><Icon name="star" size={13} /></button>
    )}
    </div>
  )
}

/** Opening a card: an upcoming one says when it starts; else its player (an event's, at its first channel). */
function useOpen() {
  const navigate = useNavigate()
  const [notice, notify] = useNotice()
  const open = useCallback((c: api.LiveCard) => {
    if (notYet(c)) return notify(c.startsAt ? `Starts ${when(c.startsAt)}` : "This hasn't started yet")
    navigate(`/live/watch/${c.id}`, { state: { card: c } })
  }, [navigate, notify])
  return [open, notice] as const
}

// ---------- The page ----------

export default function LiveTv() {
  const [page, setPage] = useState<api.LivePage>()
  const [error, setError] = useState<unknown>()
  // (Try again: asked afresh.)
  const [tries, setTries] = useState(0)
  const [peek, setPeek] = useState<api.LiveCard>()
  const [open, notice] = useOpen()
  const session = useSession()
  const isAdmin = !!session.all.find(p => p.id === session.profileId)?.isAdmin
  useEffect(() => {
    let gone = false, timer: ReturnType<typeof setTimeout> | undefined
    const load = () => api.livePage().then(p => { if (!gone) { setPage(p); setError(undefined) } }, e => {
      if (gone) return
      setError(e)
      // (Asked again by itself while the tab is shown, as the TV's.)
      // (Not when this server has no Live TV (404), as on the TV.)
      if (!(e instanceof api.NotSignedIn) && !(e instanceof ApiError && e.status === 404)) timer = setTimeout(again, RELOAD_MS)
    })
    const again = () => { if (document.visibilityState === 'visible') load(); else document.addEventListener('visibilitychange', shown) }
    const shown = () => {
      if (document.visibilityState !== 'visible') return
      document.removeEventListener('visibilitychange', shown)
      load()
    }
    load()
    return () => { gone = true; clearTimeout(timer); document.removeEventListener('visibilitychange', shown) }
  }, [tries])
  // Every kind there is (the household's countries and languages applied), for More to explore.
  const [kinds_, setKinds] = useState<api.LiveTvOption[]>()
  useEffect(() => { api.liveBrowse({ limit: 1 }).then(r => setKinds(r.options.kinds), () => {}) }, [])

  if (error && !page) {
    const missing = error instanceof ApiError && error.status === 404
    return <Problem words={missing ? "Live TV isn't available on this server." : errorWords(error)} retry={missing ? undefined : () => { setError(undefined); setTries(n => n + 1) }} />
  }
  if (!page) return <div className="lv-loading" role="status" aria-label="Loading Live TV"><RowSkeleton /><RowSkeleton /></div>
  if (page.lists === 0) {
    return (
      <div className="lv-empty">
        <span className="eyebrow title-eyebrow">Live TV</span>
        <h1>No channel lists yet</h1>
        <p>Live TV shows the channels from your household's own channel lists (M3U playlists).
          {isAdmin ? ' Add one in Settings, under Household.' : " Your household's admin can add one in Settings."}</p>
        {isAdmin && <Link className="btn primary" to="/settings#livetv">Add a channel list</Link>}
      </div>
    )
  }
  // A card's star: saved, then the page asked again (My channels comes or goes, and moves).
  const star = (c: api.LiveCard) => api.liveFavourite(c.id, !c.favourite).then(() => api.livePage()).then(setPage, () => {})
  const top = peek ?? page.hero ?? page.rows.find(r => r.channels.length)?.channels[0]
  // As Home: the household's own rows and My channels, then the first few kinds as rows; the rest of
  // the kinds are tiles in one last row, each opening its Browse all.
  // My channels first, and only when this profile has some (as on the TV); then the household's own
  // rows and the kinds, as the server gives them.
  const mine = page.rows.filter(r => r.key === 'mine' && r.channels.length)
  const rows = [...mine, ...page.rows.filter(r => r.key !== 'mine' && r.channels.length)]
  let kinds = 0
  const rowsShown = rows.filter(r => !r.kind || r.row || ++kinds <= KIND_ROWS)
  const rowsLater = rows.filter(r => !rowsShown.includes(r))
  // Kinds with no row on the page at all (the server sends a few): tiles too, after those.
  const kindsLater = (kinds_?.filter(k => k.count > 0 && !rows.some(r => r.kind === k.id && !r.row)) ?? [])
  return (
    <div className="title-page lv-page">
      {/* (A saved copy shown, and asking for it again failed: said.) */}
      {!!error && <div className="waking-line glass" role="status">{isOffline(error) ? "Can't reach Nightcap right now. Showing what was here." : "Couldn't refresh this page. Showing what was here."}</div>}
      {top && <Top c={top} onPlay={() => open(top)} />}
      {rowsShown.map(r => (
        <Shelf key={r.key} title={r.title} className="lv-cards" extra={<RowCount r={r} />}>
          {r.channels.map(c => <LiveCardView key={c.id} c={c} onPeek={() => setPeek(c)} onOpen={() => open(c)} onStar={() => star(c)} />)}
          {r.key !== 'mine' && (
            <Link className="lv-card lv-all" state={{ title: r.title }} to={browseTo(r)}>
              <span className="lv-tile">
                {/* (A few of the row's own, dimmed behind how many there are.) */}
                <span className="lv-all-mosaic" aria-hidden>{mosaic(r.channels).map((c, i) => <span key={i}><Art c={c} /></span>)}</span>
                <span className="lv-all-face"><b>{(r.count ?? r.channels.length).toLocaleString()}</b><small>channels</small></span>
                <span className="lv-all-go" aria-hidden><Icon name="chevron" size={16} /></span>
              </span>
              <span className="lv-name">Browse all</span>
              <span className="lv-sub">{r.title}</span>
            </Link>
          )}
        </Shelf>
      ))}
      {rowsLater.length + kindsLater.length > 0 && (
        <Shelf title="More to explore" className="lv-cards lv-kind-tiles">
          {rowsLater.map(r => (
            <Link key={r.key} className="lv-card lv-all lv-kind" state={{ title: r.title }} to={browseTo(r)}>
              <span className="lv-tile">
                <span className="lv-all-mosaic" aria-hidden>{mosaic(r.channels).map((c, i) => <span key={i}><Art c={c} /></span>)}</span>
                <span className="lv-all-face"><b className="lv-kind-name">{r.title}</b><small>{(r.count ?? r.channels.length).toLocaleString()} {(r.count ?? r.channels.length) === 1 ? 'channel' : 'channels'}</small></span>
                <span className="lv-all-go" aria-hidden><Icon name="chevron" size={16} /></span>
              </span>
            </Link>
          ))}
          {kindsLater.map(k => (
            <Link key={k.id} className="lv-card lv-all lv-kind" state={{ title: k.name }} to={`/live/browse?kind=${encodeURIComponent(k.id)}`}>
              <span className="lv-tile lv-kind-plain" style={{ '--hue': hueOf(k.id) } as CSSProperties}>
                <span className="lv-all-face"><b className="lv-kind-name">{k.name}</b><small>{k.count.toLocaleString()} {k.count === 1 ? 'channel' : 'channels'}</small></span>
                <span className="lv-all-go" aria-hidden><Icon name="chevron" size={16} /></span>
              </span>
            </Link>
          ))}
        </Shelf>
      )}
      {/* Every channel at once: a wide card over a wall of their logos, at the foot of the page. */}
      <Link className="lv-every" to="/live/browse">
        <span className="lv-every-wall" aria-hidden>
          {wall(page.rows.flatMap(r => r.channels).filter(c => c.logo)).map((c, i) => <span key={i}><Art c={c} /></span>)}
        </span>
        <span className="lv-every-text">
          <small>Every channel</small>
          <b>Browse all {page.shown.toLocaleString()} {page.shown === 1 ? 'channel' : 'channels'}</b>
          <span>Search by name, or look through every kind.</span>
        </span>
        <span className="lv-every-go">Browse all<Icon name="chevron" size={16} /></span>
      </Link>
      {page.hidden > 0 && <p className="lv-foot">{page.hidden} {page.hidden === 1 ? "channel didn't" : "channels didn't"} play on this device and {page.hidden === 1 ? 'is' : 'are'} hidden here for a while.</p>}
      {notice}
    </div>
  )
}

/** A tint of its own for a kind's tile (the same each time). */
function hueOf(id: string) {
  let h = 0
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360
  return h
}

// (How many kinds are rows of their own; any more are tiles in More to explore.)
const KIND_ROWS = 6
/** A first load that failed: asked again after this. */
const RELOAD_MS = 10_000

/** Where a row's Browse all goes: its own channels (a household row's, or a kind's). */
const browseTo = (r: api.LiveRow) => `/live/browse?${r.row ? `row=${encodeURIComponent(r.key)}` : r.kind ? `kind=${encodeURIComponent(r.kind)}` : ''}`

/** Six of a row's channels for its Browse all tile (a short row's again, to fill it). */
const mosaic = (cs: api.LiveCard[]) => (cs.length ? Array.from({ length: 6 }, (_, i) => cs[i % cs.length]) : [])

/** Forty channels for the wall behind Browse all channels (fewer again, to fill it). */
const wall = (cs: api.LiveCard[]) => (cs.length ? Array.from({ length: 40 }, (_, i) => cs[i % cs.length]) : [])

const RowCount = ({ r }: { r: api.LiveRow }) => (r.count && r.count > r.channels.length ? <span className="lv-rowcount">{r.count.toLocaleString()}</span> : null)

/** The card pointed at, large: its picture, name, what it is, and Play. */
function Top({ c, onPlay }: { c: api.LiveCard; onPlay: () => void }) {
  const line = stateLine(c)
  // (A household's own item's kind is just "Other": not worth saying.)
  const where = [c.kind === 'other' ? null : c.kindName, ...c.countries.map(x => x.name).slice(0, 2), ...c.languages.map(x => x.name).slice(0, 2)]
  return (
    <section className="title-top lv-top">
      <div className="title-art lv-top-art" style={{ '--hue': c.hue } as CSSProperties}><Art c={c} big /></div>
      <div className="title-text">
        <div className={`eyebrow title-eyebrow${c.state === 'live' ? ' lv-live' : ''}`}>{c.state === 'live' && <i aria-hidden />}{line ?? 'Live TV'}</div>
        <h1 className={c.name.length > 18 ? 'long' : ''}>{c.name}</h1>
        <div className="title-meta">{where.filter(Boolean).join('  ·  ')}</div>
        {c.about && <p className="title-reason">{c.about}</p>}
        {c.channels && <p className="lv-chans">{c.channels.map(x => x.name).join('  ·  ')}</p>}
        <div className="title-actions">
          <button className="btn primary" onClick={onPlay} disabled={notYet(c)}>
            <Icon name="play" size={18} /> {notYet(c) ? (c.startsAt ? `Starts ${when(c.startsAt)}` : 'Not started') : 'Watch'}
          </button>
        </div>
      </div>
    </section>
  )
}

// ---------- Browse all ----------

const PAGE = 60

export function LiveBrowse() {
  const [search] = useSearchParams()
  const location = useLocation()
  const row = search.get('row') ?? undefined
  // (The row it was opened from names the page; the household's places, set by its admin, apply.)
  const rowTitle = (location.state as { title?: string } | null)?.title
  const [kind, setKind] = useState(search.get('kind') ?? '')
  const [q, setQ] = useState('')
  const [typed, setTyped] = useState('')
  const [found, setFound] = useState<api.LiveBrowse>()
  const [more, setMore] = useState<api.LiveCard[]>([])
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<unknown>()
  const [tries, setTries] = useState(0)
  const [moreNotice, notifyMore] = useNotice()
  // Stars changed here (the cards keep what the server said until asked again).
  const [starred, setStarred] = useState<Record<string, boolean>>({})
  const [open, notice] = useOpen()
  // (Typing settles for a moment before it's asked.)
  useEffect(() => { const t = setTimeout(() => setQ(typed.trim()), 350); return () => clearTimeout(t) }, [typed])
  const ask = useCallback((offset: number) => api.liveBrowse({
    row, kind: row ? undefined : kind || undefined, q: q || undefined, offset, limit: PAGE,
  }), [row, kind, q])
  useEffect(() => {
    let gone = false
    setBusy(true); setFailed(undefined)
    ask(0).then(r => { if (!gone) { setFound(r); setMore([]) } }, e => { if (!gone) setFailed(e) }).finally(() => !gone && setBusy(false))
    return () => { gone = true }
  }, [ask, tries])
  const all = [...(found?.channels ?? []), ...more]
  const kindName = found?.options.kinds.find(k => k.id === kind)?.name
  const title = row ? rowTitle ?? 'Browse all' : kindName ?? 'All channels'
  return (
    <div className="lv-browse">
      <div className="lv-browse-head">
        <BackButton />
        <div className="lv-browse-title">
          <h1>{title}</h1>
          {found && <span className="lv-rowcount">{found.count.toLocaleString()} {found.count === 1 ? 'channel' : 'channels'}</span>}
        </div>
      </div>
      <div className="lv-browse-tools">
        <label className="lv-find">
          <Icon name="search" size={18} />
          <input type="search" value={typed} onChange={e => setTyped(e.target.value)} placeholder={`Search ${(kindName ?? rowTitle ?? 'channels').toLowerCase()}`}
            aria-label="Search channels" autoComplete="off" spellCheck={false} />
        </label>
        {!row && !rowTitle && found && found.options.kinds.length > 1 && (
          <KindStrip kinds={found.options.kinds} kind={kind} onPick={setKind} />
        )}
      </div>
      {!!failed && !found && <Problem words={errorWords(failed)} retry={() => setTries(n => n + 1)} />}
      {!found && !failed && busy && <Waiting after={300} />}
      <div className="lv-grid">
        {all.map(c => <LiveCardView key={c.id} c={{ ...c, favourite: starred[c.id] ?? c.favourite }} onPeek={() => {}} onOpen={() => open(c)}
          onStar={() => { const on = !(starred[c.id] ?? c.favourite); setStarred(x => ({ ...x, [c.id]: on })); api.liveFavourite(c.id, on).catch(() => setStarred(x => ({ ...x, [c.id]: !on }))) }} />)}
      </div>
      {found && !all.length && !busy && <p className="lv-none">{q ? `Nothing called “${q}” here.` : 'No channels here.'}</p>}
      {found && all.length < found.count && (
        <button className="btn lv-more" disabled={busy} onClick={() => { setBusy(true); ask(all.length).then(r => setMore(m => [...m, ...r.channels]), e => notifyMore(errorWords(e))).finally(() => setBusy(false)) }}>
          {busy ? 'Loading…' : 'Show more'}
        </button>
      )}
      {notice}
      {moreNotice}
    </div>
  )
}

/** Every kind on one line that scrolls sideways (the wheel too), the one shown lit and in sight; an
 * arrow, and a fade, on whichever side has more. */
function KindStrip({ kinds, kind, onPick }: { kinds: api.LiveTvOption[]; kind: string; onPick: (k: string) => void }) {
  const strip = useRef<HTMLDivElement>(null)
  const [more, setMore] = useState({ left: false, right: false })
  const measure = useCallback(() => {
    const el = strip.current
    if (el) setMore({ left: el.scrollLeft > 4, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4 })
  }, [])
  useEffect(() => {
    const el = strip.current
    if (!el) return
    el.querySelector<HTMLElement>('.on')?.scrollIntoView({ block: 'nearest', inline: 'center' })
    measure()
    // (A mouse wheel turned up or down moves it sideways.)
    const wheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && el.scrollWidth > el.clientWidth) { e.preventDefault(); el.scrollLeft += e.deltaY }
    }
    el.addEventListener('wheel', wheel, { passive: false })
    window.addEventListener('resize', measure)
    return () => { el.removeEventListener('wheel', wheel); window.removeEventListener('resize', measure) }
  }, [measure, kinds.length])
  const step = (dir: 1 | -1) => strip.current?.scrollBy({ left: dir * strip.current.clientWidth * 0.7, behavior: 'smooth' })
  return (
    <div className={`lv-kinds-wrap${more.left ? ' more-left' : ''}${more.right ? ' more-right' : ''}`}>
      <div ref={strip} className="lv-kinds" role="radiogroup" aria-label="Kind" onScroll={measure}>
        <button role="radio" aria-checked={!kind} className={!kind ? 'on' : ''} onClick={() => onPick('')}>All</button>
        {kinds.map(k => (
          <button role="radio" aria-checked={kind === k.id} key={k.id} className={kind === k.id ? 'on' : ''} onClick={() => onPick(k.id)}>{k.name}</button>
        ))}
      </div>
      {more.left && <button className="lv-kinds-step left" aria-label="Earlier kinds" onClick={() => step(-1)}><Icon name="chevron" size={16} /></button>}
      {more.right && <button className="lv-kinds-step right" aria-label="More kinds" onClick={() => step(1)}><Icon name="chevron" size={16} /></button>}
    </div>
  )
}

// ---------- The player ----------

const START_MS = 20_000          // a stream that hasn't started by then: the next one
const CALM_MS = 30_000           // playing this long since a reconnect: a later drop is tried again once more
const WATCHING_EVERY_MS = 60_000 // watch time is said this often (and as the player closes)
const PICKS = 'nightcap.live.picks'

/** Which channel of an event this browser last watched (by the event's first channel). */
const lastPick = (eventId: string) => { try { return JSON.parse(localStorage.getItem(PICKS) ?? '{}')[eventId] as string | undefined } catch { return undefined } }
const savePick = (eventId: string, channel: string) => {
  try { const all = JSON.parse(localStorage.getItem(PICKS) ?? '{}'); all[eventId] = channel; localStorage.setItem(PICKS, JSON.stringify(all)) } catch { /* storage off */ }
}

export function LivePlayer() {
  const { channel = '' } = useParams()
  useEffect(playerShown, [])
  const location = useLocation()
  const navigate = useNavigate()
  const card = (location.state as { card?: api.LiveCard } | null)?.card
  // An event: its channels stay offered while one of them plays.
  const event = card?.channels && card.channels.length > 1 ? card : undefined
  const [playing, setPlaying] = useState(() => (event ? lastPick(event.id) ?? channel : channel))
  const [info, setInfo] = useState<api.LiveCard | undefined>(card)
  const [status, setStatus] = useState<'opening' | 'reconnecting' | 'playing' | 'blocked' | 'none'>('opening')
  const [why, setWhy] = useState<string>()
  const [favourite, setFavourite] = useState(card?.favourite ?? false)
  const [paused, setPaused] = useState(false)
  const [muted, setMuted] = useState(false)
  // Behind the live moment (paused a while, or a slow connection): LIVE becomes "Go live".
  const [behind, setBehind] = useState(false)
  const [idle, setIdle] = useState(false)
  // The channels panel (an event's), open.
  const [panel, setPanel] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const video = useRef<HTMLVideoElement>(null)
  // What plays now: hls.js (where the live moment is) and whether the stream is live at all (a
  // stream can be a plain video: that's never "behind").
  const engine = useRef<{ hls?: { liveSyncPosition: number | null }; live: boolean }>({ live: false })

  /** The live moment: where hls.js would sync to, else the end of what's there (less a little). */
  const liveEdge = () => {
    const v = video.current, h = engine.current.hls
    if (!v) return null
    if (h?.liveSyncPosition != null) return h.liveSyncPosition
    return v.seekable.length ? v.seekable.end(v.seekable.length - 1) - 3 : null
  }
  const goLive = () => {
    const v = video.current, edge = liveEdge()
    if (v && edge != null && engine.current.live) v.currentTime = edge
    if (v?.paused) v.play().catch(() => {})
    setBehind(false)
  }

  useEffect(() => {
    const v = video.current
    if (!v) return
    let gone = false, hls: { destroy(): void } | undefined, timer: ReturnType<typeof setTimeout> | undefined
    let ticker: ReturnType<typeof setInterval> | undefined, since = 0
    // The channel's stream played this time (so a failure after is a drop, tried again once). Its one
    // retry comes back only after a while playing well: a stream that keeps dropping moves on to the next.
    let played = false, reconnected = false, calm: ReturnType<typeof setTimeout> | undefined
    setStatus('opening'); setWhy(undefined); setBehind(false)
    const said = () => { if (since) { const s = Math.round((Date.now() - since) / 1000); since = Date.now(); if (s > 0) api.liveWatching(playing, Math.min(600, s)) } }
    const stop = () => { clearTimeout(timer); hls?.destroy(); hls = undefined; engine.current = { live: false }; v.removeAttribute('src'); v.load() }
    // Each stream in turn (best first) until one plays.
    const tryFrom = async (streams: api.LivePlay['streams'], i: number): Promise<void> => {
      stop()
      if (gone) return
      if (i >= streams.length) {
        setStatus('none'); setWhy("None of its streams played here. It may play on the TV.")
        // (Not one that played here and then dropped: that's the source's outage, not a dead channel.)
        if (!played) api.liveFailed(playing)
        return
      }
      const s = streams[i]
      let got: Opened | null = { url: s.url }
      if (s.recipe) {
        try { got = opened(await handler({ link: s.url, recipe: s.recipe, target: () => api.linkTarget(s.url) })) } catch { got = null }
      }
      if (gone) return
      if (!got) return tryFrom(streams, i + 1)
      const address = got.url
      // (Each try acts on its failure once: a fatal hls.js error and the video's own error can both come.)
      let handled = false
      const next = () => { if (gone || handled) return; handled = true; tryFrom(streams, i + 1) }
      const failed = () => {
        if (gone || handled) return
        clearTimeout(calm)
        // It was playing and dropped (a short outage at the source): the same stream again, once, before
        // the next (the start limit still guards it).
        if (played && !reconnected) {
          reconnected = true
          handled = true
          v.onerror = null
          v.onplaying = null
          setStatus('reconnecting')
          tryFrom(streams, i)
          return
        }
        next()
      }
      timer = setTimeout(next, START_MS)
      v.onplaying = () => {
        clearTimeout(timer)
        if (gone) return
        played = true
        clearTimeout(calm)
        calm = setTimeout(() => { reconnected = false }, CALM_MS)
        setStatus('playing')
        if (!since) since = Date.now()
      }
      v.onerror = failed
      const { default: Hls } = await import('hls.js')
      if (gone) return
      // (A handler's own settings need hls.js: where there's none, not this stream.)
      if (got.hls && !Hls.isSupported()) return next()
      if (Hls.isSupported()) {
        const h = new Hls({ maxBufferLength: 20, liveSyncDurationCount: 3, ...got.hls })
        h.on(Hls.Events.ERROR, (_e, data) => { if (data.fatal) failed() })
        h.on(Hls.Events.LEVEL_LOADED, (_e, data) => { engine.current.live = !!data.details.live })
        h.loadSource(address)
        h.attachMedia(v)
        hls = h
        engine.current = { hls: h, live: false }
      } else {
        // (Safari plays HLS itself: a live stream's length is endless.)
        v.src = address
        v.onloadedmetadata = () => { engine.current.live = v.duration === Infinity }
      }
      v.play().catch(e => {
        // (The browser wants a click first: that's not the stream failing.)
        if ((e as Error).name === 'NotAllowedError' && !gone) { clearTimeout(timer); setStatus('blocked') }
      })
    }
    api.livePlay(playing).then(p => {
      if (gone) return
      setInfo(i => (i && i.id === p.channel.id ? i : p.channel))
      setFavourite(p.channel.favourite)
      return tryFrom(p.streams, 0)
    }, e => { if (!gone) { setStatus('none'); setWhy(errorWords(e)) } })
    ticker = setInterval(said, WATCHING_EVERY_MS)
    return () => { gone = true; said(); clearInterval(ticker); clearTimeout(calm); stop() }
  }, [playing])

  // Paused, then played again: on from where it stopped (as far back as the stream still keeps). How
  // far behind the live moment it is, every couple of seconds: paused, or more than BEHIND_S, LIVE
  // becomes Go live, the way to the live moment.
  useEffect(() => {
    const v = video.current
    if (!v) return
    const onPause = () => setPaused(true)
    const onPlay = () => setPaused(false)
    v.addEventListener('pause', onPause)
    v.addEventListener('play', onPlay)
    const check = setInterval(() => {
      const edge = liveEdge()
      setBehind(engine.current.live && edge != null && (v.paused || edge - v.currentTime > BEHIND_S))
    }, 2000)
    return () => { v.removeEventListener('pause', onPause); v.removeEventListener('play', onPlay); clearInterval(check) }
  }, [])
  useEffect(() => { if (video.current) video.current.muted = muted }, [muted])

  // The controls fade after a few seconds without the pointer moving (not while paused or opening).
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const wake = useCallback(() => {
    setIdle(false)
    clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => setIdle(true), HIDE_MS)
  }, [])
  useEffect(() => { wake(); return () => clearTimeout(hideTimer.current) }, [wake])

  const toggle = () => { const v = video.current; if (!v) return; if (v.paused) v.play().catch(() => {}); else v.pause() }
  const fullscreen = () => (document.fullscreenElement ? document.exitFullscreen() : box.current?.requestFullscreen())
  const pick = (id: string) => { if (event) savePick(event.id, id); setPlaying(id) }
  const star = () => {
    const on = !favourite
    setFavourite(on)
    api.liveFavourite(playing, on).catch(() => setFavourite(!on))
  }
  // Keys: space plays and pauses, 1-9 an event's channels (C its list), M mute, F full screen, L the live moment, Esc back.
  const panelOpen = useRef(panel)
  panelOpen.current = panel
  const keys = useRef({ toggle, pick, fullscreen, goLive })
  keys.current = { toggle, pick, fullscreen, goLive }
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      wake()
      if (e.key === 'Escape' && panelOpen.current) setPanel(false)
      else if (e.key === 'Escape' && !document.fullscreenElement) navigate(-1)
      else if (e.key === 'c' && event?.channels) setPanel(p => !p)
      else if (e.key === ' ') { e.preventDefault(); keys.current.toggle() }
      else if (e.key === 'f') keys.current.fullscreen()
      else if (e.key === 'm') setMuted(m => !m)
      else if (e.key === 'l') keys.current.goLive()
      else if (event?.channels && /^[1-9]$/.test(e.key)) { const x = event.channels[Number(e.key) - 1]; if (x) keys.current.pick(x.id) }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [navigate, event, wake])

  const shown = event ?? info
  const hidden = idle && status === 'playing' && !paused && !panel
  return (
    <div ref={box} className={`lv-player${hidden ? ' idle' : ''}`} onMouseMove={wake} onClick={wake}>
      <video ref={video} className="lv-video" playsInline onClick={toggle} onDoubleClick={fullscreen} />
      <div className="lv-player-top">
        <button className="lv-round" aria-label="Back" onClick={() => navigate(-1)}><Icon name="chevron" size={20} /></button>
        <div className="lv-player-title">
          <b>{shown?.name ?? 'Live TV'}</b>
          {shown?.about && <small>{shown.about}</small>}
        </div>
        <button className={`lv-round${favourite ? ' on' : ''}`} aria-label={favourite ? 'Take out of My channels' : 'Add to My channels'}
          title={favourite ? 'In My channels' : 'Add to My channels'} onClick={star}><Icon name="star" size={18} /></button>
      </div>
      {status === 'playing' && (
        <div className="lv-bar">
          <button className="player-round big" aria-label={paused ? 'Play' : 'Pause'} onClick={toggle}>
            {paused ? <Icon name="play" size={26} /> : <span className="pause-bars" />}
          </button>
          {shown?.state === '24/7'
            ? <span className="lv-onair">24/7</span>
            : behind
              ? <button className="lv-onair behind" onClick={goLive} title="Back to the live moment (L)"><i aria-hidden />Go live</button>
              : <span className="lv-onair"><i aria-hidden />Live</span>}
          <span className="player-spacer" />
          {event?.channels && (
            <button className="player-chip lv-channel-chip" onClick={() => setPanel(true)} title="Channels (C)">
              <small>Channel</small><span>{event.channels.find(x => x.id === playing)?.name ?? ''}</span>
              <em>{event.channels.length}</em>
            </button>
          )}
          <button className="player-round" aria-label={muted ? 'Sound on' : 'Mute'} onClick={() => setMuted(m => !m)}>
            <Icon name={muted ? 'sound_off' : 'sound_on'} size={20} />
          </button>
          <button className="player-round" aria-label="Full screen" onClick={fullscreen}>⛶</button>
        </div>
      )}
      {status !== 'playing' && (
        <div className="lv-player-note">
          {status === 'opening' || status === 'reconnecting'
            ? <><span className="lv-spin" aria-hidden /> {status === 'reconnecting' ? 'Reconnecting…' : 'Opening…'}</>
            : status === 'blocked' ? <button className="btn primary" onClick={() => video.current?.play()}><Icon name="play" size={18} /> Play</button>
            : <p>{why}</p>}
          {event?.channels && status === 'none' && (
            <button className="player-chip" onClick={() => setPanel(true)}>Try another channel</button>
          )}
        </div>
      )}
      {panel && event?.channels && (
        <div className="player-panel-scrim" onClick={() => setPanel(false)}>
          <aside className="player-panel glass" aria-label="Channels" onClick={e => e.stopPropagation()}>
            <button className="player-panel-close" onClick={() => setPanel(false)} aria-label="Close"><Icon name="act_close" size={18} /></button>
            <h3>Channels</h3>
            <div className="player-panel-body" role="radiogroup">
              {event.channels.map((x, n) => (
                <button key={x.id} role="radio" aria-checked={x.id === playing} className={`panel-item lv-channel${x.id === playing ? ' on' : ''}`}
                  onClick={() => { pick(x.id); setPanel(false) }}>
                  <span>{x.name}</span>
                  {/* (Its key, for the first nine.) */}
                  {n < 9 && <kbd>{n + 1}</kbd>}
                </button>
              ))}
            </div>
          </aside>
        </div>
      )}
    </div>
  )
}

const BEHIND_S = 15   // further behind the live moment than this: "Go live"
const HIDE_MS = 3500  // the controls fade after this long without the pointer moving
