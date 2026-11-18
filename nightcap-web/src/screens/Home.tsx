import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import * as api from '../api'
import Hero, { playWhat } from '../components/Hero'
import PlayOnTv from '../components/PlayOnTv'
import Menu, { type Action } from '../components/Menu'
import { useNotice } from '../components/Notice'
import { LazyRow, RowSkeleton } from '../components/RowView'
import { errorWords, WORDS } from '../errors'
import { homeKey, keep, readKept } from '../kept'
import type { Feed, Item, Row } from '../types'
import './Home.css'

const RETRY_MS = 5000
// As on the TV: a first Home whose setting up failed is asked again after 30 s, doubling up to 5 min.
const SETUP_RETRY_FIRST_MS = 30_000
const SETUP_RETRY_MAX_MS = 300_000
// Rows drawn straight away (about a screen's worth); the rest as they're scrolled near.
const EAGER_ROWS = 4

// Home as last shown, so coming back to it (Back from a title) shows it at once, where it was
// scrolled to (by visit: each entry in the history has its own place), while it's asked for again.
// (Kept for the profile it's for: another profile's never shows, even for a moment. Home and its
// Shows and Movies pages each keep their own.)
const last = new Map<string, { profile: string | null; feed: Feed }>()
// Also kept in this browser (kept.ts): the big picture and the first rows, so opening the app shows
// the last Home at once, even while the server is waking; then it's asked for again.
const KEPT_ROWS = 6
const lastFeed = (page: string) => {
  const p = api.profile.get()
  const l = last.get(page)
  if (l) return l.profile === p ? l.feed : undefined
  return p ? readKept<Feed>(homeKey(p, page)) : undefined
}
const scrolledTo = new Map<string, number>()

/** Home, or one of its pages ([page]: Shows "tv", Movies "movie"): the same screen, each with its own
 * rows, as on the TV. */
export default function Home({ page }: { page?: api.PageKind }) {
  const which = page ?? 'home'
  const name = page === 'tv' ? 'Shows' : page === 'movie' ? 'Movies' : 'your home screen'
  const [feed, setShown] = useState<Feed | undefined>(() => lastFeed(which))
  // ([profile]: the one it was asked for, read as the request went out: an answer for another profile
  // than the one watching now is neither shown nor kept.)
  const setFeed = (f: Feed, profile: string | null) => {
    if (profile !== api.profile.get()) return
    f = sameRows(last.get(which)?.feed, f)
    last.set(which, { profile, feed: f })
    if (profile && !f.building) keep(homeKey(profile, which), { ...f, rows: f.rows.slice(0, KEPT_ROWS) })
    setShown(f)
  }
  const [error, setError] = useState<string>()
  // (Counted, so each failure, the same words again, asks once more.)
  const [failures, setFailures] = useState(0)
  const [focused, setFocused] = useState<Item>()
  const [menu, setMenu] = useState<{ title: string; subtitle?: string; actions: Action[] }>()
  const [notice, notify] = useNotice()
  const [onTv, setOnTv] = useState<Item>()
  // The full Home has just come in place of the one being set up (it fades in).
  const [arrived, setArrived] = useState(false)

  // The title under the pointer takes over the big picture, and keeps it while the pointer moves
  // up to its buttons. Only once the pointer has been off the rows and the picture for a moment
  // does the featured carousel come back.
  const release = useRef(0)
  // (A peek waits a moment: the pointer crossing a row on its way somewhere doesn't swap the picture
  // at every card.)
  const peeking = useRef(0)
  const hold = () => clearTimeout(release.current)
  const letGo = () => {
    hold()
    clearTimeout(peeking.current)
    release.current = window.setTimeout(() => { setFocused(undefined); applyWaiting() }, 700)
  }
  const peek = useCallback((item: Item) => {
    hold()
    clearTimeout(peeking.current)
    peeking.current = window.setTimeout(() => setFocused(item), 120)
  }, [])
  useEffect(() => () => { hold(); clearTimeout(peeking.current) }, [])
  // (The rows' menu, the same function on every draw, so a row isn't drawn again for nothing; it
  // calls the latest openMenu, defined below.)
  const menuOf = useRef<(row: Row, item: Item) => void>(() => {})
  const onMenu = useCallback((row: Row, item: Item) => menuOf.current(row, item), [])

  // Home as saved shows at once. When the server says it's out of date (stale), a refresh is
  // asked for, and the new Home replaces it in place: rows keep where they're scrolled to, and
  // while the pointer is in them the change waits until it leaves, so nothing moves under it.
  const browsing = useRef(false)
  const waiting = useRef<{ feed: Feed; profile: string | null } | undefined>(undefined)
  // (A first Home still being set up is replaced at once, pointer or not: it's only a placeholder.)
  const building = useRef(!!lastFeed(which)?.building)
  const applyWaiting = () => {
    if (!waiting.current || (browsing.current && !building.current)) return
    const { feed: f, profile } = waiting.current
    waiting.current = undefined
    if (profile !== api.profile.get()) return
    if (building.current && !f.building) setArrived(true)
    building.current = !!f.building
    setFeed(f, profile)
  }
  const fresh = (f: Feed, profile: string | null) => {
    // (An answer that isn't a Home leaves the one shown.)
    if (!Array.isArray(f?.rows)) return
    waiting.current = { feed: f, profile }; applyWaiting()
  }
  const refreshing = useRef(false)
  const setupRetryMs = useRef(SETUP_RETRY_FIRST_MS)
  const setupRetry = useRef<(() => void) | undefined>(undefined)
  useEffect(() => () => setupRetry.current?.(), [])
  // (A change made while a refresh is on its way: that refresh's Home is from before it, so it's
  // dropped, and Home is asked for again once it's back.)
  const changes = useRef(0)
  const again = useRef(false)
  const refresh = useCallback(() => {
    if (refreshing.current) { again.current = true; return }
    refreshing.current = true
    again.current = false
    setupRetry.current?.()
    const profile = api.profile.get()
    const since = changes.current
    ;(page ? api.refreshPage(page) : api.refreshHome()).then(f => {
      setupRetryMs.current = SETUP_RETRY_FIRST_MS
      if (since !== changes.current) return
      fresh(f, profile)
    }, () => {
      // (A first Home with nothing else to show: asked again, less often each time, rather than left
      // setting up; only while the page is in view.)
      if (!building.current || profile !== api.profile.get()) return
      setupRetry.current = laterWhileVisible(refresh, setupRetryMs.current)
      setupRetryMs.current = Math.min(setupRetryMs.current * 2, SETUP_RETRY_MAX_MS)
    }).finally(() => {
      refreshing.current = false
      if (again.current) refresh()
    })
  }, [page])

  const reload = useCallback(() => {
    // (The profile it's asked for, as it goes out: one switched to meanwhile never gets this answer.)
    const profile = api.profile.get()
    const since = changes.current
    return (page ? api.pageFeed(page) : api.homeFeed()).then(f => {
      if (profile !== api.profile.get()) return
      // (Saved before a change made meanwhile: it would undo it. The change's own refresh brings Home.)
      if (since !== changes.current) { refresh(); return }
      building.current = !!f.building
      setFeed(f, profile); setError(undefined)
      if (f.stale || f.building) refresh()
    }, e => { if (profile === api.profile.get()) { setError(errorWords(e)); setFailures(n => n + 1) } })
  }, [refresh])
  useEffect(() => { reload() }, [reload])

  // Back where it was: the place this visit had (rows not drawn yet keep their size, so it's exact).
  const visit = useLocation().key
  const restored = useRef(false)
  useLayoutEffect(() => {
    if (restored.current || !feed) return
    restored.current = true
    const y = scrolledTo.get(visit)
    if (y) window.scrollTo(0, y)
  }, [feed, visit])
  useEffect(() => {
    let frame = 0
    const keep = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => scrolledTo.set(visit, window.scrollY)) }
    window.addEventListener('scroll', keep, { passive: true })
    return () => { cancelAnimationFrame(frame); window.removeEventListener('scroll', keep) }
  }, [visit])
  // As on the TV: a Home that couldn't load (the server restarting, say) is asked for again every
  // few seconds, so it comes back by itself; only while the page is in view (a hidden tab asks again
  // when it's shown).
  useEffect(() => {
    if (!error) return
    return laterWhileVisible(reload, RETRY_MS)
  }, [error, failures, reload])

  // Before Home has come: its shape, softly shimmering, and what's happening in plain words.
  if (!feed) {
    return (
      <div className="home">
        <HeroNote title={error ? "Can't reach Nightcap right now" : `Loading ${name}…`}
          line={error ? "Trying again in a moment. Nothing's lost." : undefined} quiet={!error} />
        <div className="rows">{[0, 1, 2].map(i => <RowSkeleton key={i} />)}</div>
      </div>
    )
  }

  // A change from Home: saved, then Home is brought up to date so every row matches the server.
  // ([edit]: Home changed at once, not when the refresh comes: the title leaving its row, or put in
  // My List.)
  const act = async (job: Promise<unknown>, done: string, edit?: { row: string; id: string } | ((rows: Row[]) => Row[])) => {
    try {
      await job
      changes.current++
      // (A Home held while browsing is from before the change: it would undo it.)
      waiting.current = undefined
      notify(done)
      // (The latest Home, not the one when the menu opened: a refresh may have come since.)
      const now = last.get(which)?.feed ?? feed
      if (edit && now) {
        const profile = api.profile.get()
        const rows = typeof edit === 'function' ? edit(now.rows)
          : now.rows.map(r => (r.id === edit.row ? { ...r, items: r.items.filter(i => i.id !== edit.id) } : r)).filter(r => r.items.length)
        setFeed({ ...now, rows }, profile)
      }
      refresh()
    } catch {
      notify("Couldn't save that. Try again.")
    }
  }

  // The TV's long-press menus.
  menuOf.current = (row: Row, item: Item) => {
    const name = item.name ?? 'This title'
    if (row.id === 'continue') {
      const series = item.type === 'series'
      const video = item.videoId ?? item.id
      const what = series ? item.episode ?? 'This episode' : name
      const actions: Action[] = [
        { icon: 'play', label: 'Play on TV', run: () => setOnTv(item) },
        { icon: 'act_watched', label: series ? `Mark ${item.episode ?? 'episode'} as watched` : 'Mark as watched',
          // (A series stays: its next episode takes the place, when the refresh comes.)
          run: () => act(api.markWatched(item.type, video, true), `${what} marked as watched`, series ? undefined : { row: row.id, id: item.id }) },
        { icon: 'act_unwatched', label: series ? `Mark ${item.episode ?? 'episode'} as unwatched` : 'Mark as unwatched',
          run: () => act(api.markWatched(item.type, video, false), `${what} marked as unwatched`) },
      ]
      if (series) actions.push(item.muted
        ? { icon: 'act_bell', label: 'Tell me about new episodes', run: () => act(api.setNotify(item.id, true), `You'll hear about new episodes of ${name}`) }
        : { icon: 'act_bell_off', label: "Don't tell me about new episodes", run: () => act(api.setNotify(item.id, false), `No more new-episode alerts for ${name}`) })
      return setMenu({ title: name, subtitle: series ? item.episode : item.year, actions })
    }
    const kind = [item.type === 'series' ? 'Series' : 'Film', item.year].filter(Boolean).join('  ·  ')
    // My List: taking it off (it leaves that row only, as the Android TV's).
    if (row.id === 'mylist' && (item.type === 'movie' || item.type === 'series')) {
      const type = item.type
      return setMenu({
        title: name, subtitle: kind,
        actions: [
          { icon: 'play', label: 'Play on TV', run: () => setOnTv(item) },
          { icon: 'act_close', label: 'Remove from My List', run: () => act(api.setMyList(item.id, type, false), `${name} removed from My List`, { row: row.id, id: item.id }) },
        ],
      })
    }
    setMenu({
      title: name,
      subtitle: kind,
      actions: [
        { icon: 'play', label: 'Play on TV', run: () => setOnTv(item) },
        { icon: 'act_watched', label: 'Mark as watched', run: () => act(api.markWatched(item.type, item.id, true), `${name} marked as watched`, { row: row.id, id: item.id }) },
        { icon: 'act_not_interested', label: 'Not interested', run: () => act(api.notInterested(item.id, item.type, name, row.id), `You won't see ${name} again`, { row: row.id, id: item.id }) },
        // (The refreshed Home has it in My List; it stays in the other rows too.)
        ...(item.type === 'movie' || item.type === 'series'
          ? [{ icon: 'add' as const, label: 'Add to My List', run: () => act(api.setMyList(item.id, item.type as 'movie' | 'series', true), `${name} added to My List`, page ? undefined : addToMyList(item)) }]
          : []),
      ],
    })
  }

  return (
    <div className="home">
      <PageTabs />
      {feed.building && !focused
        ? <HeroNote title={feed.rows.length ? `Setting up the rest of ${name}…` : `Setting up ${name}…`}
            line="Picking rows for you. The first time takes up to a minute." quiet />
        // (A page with nothing on it, not being set up: said, not a blank screen.)
        : !feed.rows.length && !feed.featured.length ? <HeroNote title="Nothing here yet." />
        : <Hero featured={feed.featured} peek={focused} onEnter={hold} onLeave={letGo} onPlayOnTv={setOnTv} />}
      <div className={`rows${arrived ? ' arrived' : ''}`}
        onMouseEnter={() => { browsing.current = true }} onMouseLeave={() => { browsing.current = false; letGo() }}>
        {feed.rows.map((row, i) => (
          <LazyRow key={row.id} eager={i < EAGER_ROWS} row={row} onFocus={peek} onMenu={row.style === 'tiles' ? undefined : onMenu} />
        ))}
        {feed.building && [0, 1, 2].map(i => <RowSkeleton key={i} />)}
      </div>
      {/* (The last Home, kept, while the server can't be reached: said, so nothing seems current that isn't.) */}
      {error && <div className="waking-line glass" role="status">{error === WORDS.starting ? 'Waking up Nightcap…' : error === WORDS.offline ? "Can't reach Nightcap right now. Showing your last Home." : "Couldn't refresh Home. Showing your last one."}</div>}
      {menu && <Menu {...menu} onClose={() => setMenu(undefined)} />}
      {onTv && <PlayOnTv what={playWhat(onTv)} name={[onTv.name, onTv.episode].filter(Boolean).join('  ·  ')} onClose={() => setOnTv(undefined)} />}
      {notice}
    </div>
  )
}

/** [next], with each row that hasn't changed since [before] kept as the same object (so its row
 * isn't drawn again), and the same for the featured list. */
function sameRows(before: Feed | undefined, next: Feed): Feed {
  if (!before) return next
  const old = new Map(before.rows.map(r => [r.id, r]))
  const same = <T,>(a: T | undefined, b: T) => (a !== undefined && JSON.stringify(a) === JSON.stringify(b) ? a : b)
  return { ...next, featured: same(before.featured, next.featured), rows: next.rows.map(r => same(old.get(r.id), r)) }
}

/** Runs [fn] after [ms], but only while the page is in view: a hidden tab's waits until it's shown
 * again. Returns its cancel. */
function laterWhileVisible(fn: () => void, ms: number) {
  const shown = () => {
    if (document.visibilityState !== 'visible') return
    document.removeEventListener('visibilitychange', shown)
    fn()
  }
  const t = window.setTimeout(() => {
    if (document.visibilityState === 'visible') fn()
    else document.addEventListener('visibilitychange', shown)
  }, ms)
  return () => { clearTimeout(t); document.removeEventListener('visibilitychange', shown) }
}

/** The hero's place while there's no title to show: a line saying what's happening ([quiet]: gently
 * breathing, for something under way), and one under it. */
function HeroNote({ title, line, quiet }: { title: string; line?: string; quiet?: boolean }) {
  return (
    <section className="hero hero-note" role="status">
      <div className="hero-scrim" />
      <div className="hero-text">
        <h1 className={quiet ? 'home-breathing' : undefined}>{title}</h1>
        {line && <p>{line}</p>}
      </div>
    </section>
  )
}

/** On phones, Home's pages as words along the top (the side panel has them on wider screens): over the big
 * picture at first, on a frosted bar once the page scrolls under them. */
function PageTabs() {
  const [scrolled, setScrolled] = useState(false)
  useEffect(() => {
    const look = () => setScrolled(window.scrollY > 24)
    look()
    window.addEventListener('scroll', look, { passive: true })
    return () => window.removeEventListener('scroll', look)
  }, [])
  return (
    <nav className={`page-tabs${scrolled ? ' scrolled' : ''}`} aria-label="Home's pages">
      <NavLink to="/" end>Home</NavLink>
      <NavLink to="/shows">Shows</NavLink>
      <NavLink to="/movies">Movies</NavLink>
    </nav>
  )
}

/** Puts a title first in the My List row, or makes the row right after Continue watching (as the
 * Android TV's; Home only: the Shows and Movies pages have no My List). Not for a title in Continue
 * watching (it's there already, as the server has it). */
function addToMyList(item: Item) {
  return (rows: Row[]): Row[] => {
    if (rows.some(r => r.id === 'continue' && r.items.some(x => x.id === item.id))) return rows
    const k = rows.findIndex(r => r.id === 'mylist')
    if (k >= 0) return rows[k].items.some(x => x.id === item.id) ? rows : rows.map((r, i) => (i === k ? { ...r, items: [item, ...r.items] } : r))
    const c = rows.findIndex(r => r.id === 'continue')
    const at = (c >= 0 ? c : rows.findIndex(r => r.id === 'featured')) + 1
    return [...rows.slice(0, at), { id: 'mylist', title: 'My List', items: [item] }, ...rows.slice(at)]
  }
}
