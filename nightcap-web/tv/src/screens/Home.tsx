import { useCallback, useEffect, useRef, useState } from 'react'
import * as api from '../api'
import * as feed from '../feed'
import type { Item, Row } from '../feed'
import { focus as focusEl } from '../focus'
import { Backdrop, HeroText } from '../home/Hero'
import { Rows, type Focus } from '../home/Rows'
import { Clock, Widgets } from '../home/Widgets'
import { takeHomeAsked, useIsFront, useKeys, useNav, useOnFront } from '../nav'
import * as profiles from '../profiles'
import { notify } from '../ui/Notice'
import Rail, { type Entry } from '../ui/Rail'
import Sheet, { type Choice } from '../ui/Sheet'
import Profiles, { askWhoIsWatching } from './Profiles'
import LiveTv from './LiveTv'
import Search from './Search'
import Settings from './Settings'
import Title from './Title'
import '../home/Home.css'

// Home. It opens at once with the last Home this profile saw, then
// the server's; a newer Home never reshuffles what's being looked at (it waits until Home comes
// back to the front). Long OK on a title opens its menu; changes show at once and are undone if the
// server says no. Left on a row's first card opens the side panel; Back goes to the top.

const LONG_PRESS_MS = 500
const REFETCH_AFTER_MS = 60_000
const RETRY_MS = 5_000
/** A first Home whose setting up failed: asked again after this, doubling up to the most. */
const SETUP_RETRY_FIRST_MS = 30_000
const SETUP_RETRY_MAX_MS = 300_000
/** Away this long counts as the TV having slept (as App.tsx's SLEPT_MS). */
const SLEPT_MS = 5 * 60_000
const HELD_STEP_MS = 110
const FEATURED_EVERY_MS = 8_000

type Pin = { row: string; card: string }
type Menu = { title: string; subtitle?: string; choices: Choice[] }

const ids = (rows: Row[]) => rows.map(r => r.id).join('\n')
const cardIds = (r: Row) => r.items.map(i => i.id).join('\n')

export default function Home() {
  const nav = useNav()
  const front = useIsFront()
  const root = useRef<HTMLDivElement>(null)
  const [rows, setRows] = useState<Row[]>([])
  const [focus, setFocus] = useState<Focus>({ row: 0, at: {}, featured: 0 })
  const [inRows, setInRows] = useState(false)
  // A line on an empty Home (centred), or under its rows ([low]); [waiting]: gently breathing, for
  // something under way.
  const [status, setStatusLine] = useState<{ text: string; waiting?: boolean; low?: boolean } | null>(null)
  const setStatus = (text: string, waiting = false, low = false) => setStatusLine(text ? { text, waiting, low } : null)
  const [rail, setRail] = useState(false)
  const [menu, setMenu] = useState<Menu | null>(null)
  const [heroN, setHeroN] = useState(0)
  const [backdrop, setBackdrop] = useState<string | null>(null)

  // What's on screen, and the bookkeeping of refreshes.
  const latest = useRef({ rows, focus })
  latest.current = { rows, focus }
  const shownJson = useRef<string | null>(null)
  const shownFor = useRef<string | null | undefined>(undefined)
  const pending = useRef<string | null>(null)
  const generation = useRef(0)
  // Changes from Home whose updated Home hasn't come back yet: meanwhile the Home saved before them
  // (marked stale) isn't shown, it would put back what was changed.
  const changesSaving = useRef(0)
  const lastFetch = useRef(0)
  const seenChange = useRef(0)
  const retry = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const setupRetryMs = useRef(SETUP_RETRY_FIRST_MS)
  /** Back after a long while: the next Home from the server is shown in full, not held. */
  const freshStart = useRef(false)
  const frontRef = useRef(front)
  frontRef.current = front
  const inRowsRef = useRef(false)
  inRowsRef.current = inRows
  const featuredShownAt = useRef(Date.now())
  const lastHeldStep = useRef(0)
  // Home's pages share this screen (its cards, picture and smooth scrolling kept): null for Home,
  // "tv" for Shows, "movie" for Movies.
  const [page, setPage] = useState<feed.Page>(null)
  const pageRef = useRef<feed.Page>(null)
  const pageName = () => (pageRef.current === 'tv' ? 'Shows' : pageRef.current === 'movie' ? 'Movies' : 'your home screen')

  // ---------- Focus ----------

  // Focus goes to a card once it's drawn (after the rows it's in have rendered).
  const [want, setWant] = useState<{ row: number; i: number; n: number } | null>(null)
  const focusDom = (row: number, i: number) => setWant(w => ({ row, i, n: (w?.n ?? 0) + 1 }))
  // (Used once: a refresh afterwards mustn't pull focus back to it.)
  const used = useRef(0)
  // (Never while the side menu or a menu is open: whoever's in it stays there, and it isn't kept for
  // later either, when a late refresh would pull focus to it.)
  useEffect(() => {
    if (!want || !front || used.current === want.n) return
    if (rail || menu) { used.current = want.n; return }
    const el = root.current?.querySelector<HTMLElement>(`[data-row="${want.row}"][data-i="${want.i}"]`)
    if (el && focusEl(el)) used.current = want.n
  }, [want, rows])

  /** The first row (the carousel's dots, or the first card): at start, Back, and Home picked. With no
   * rows, the side menu, so there's always somewhere to go. */
  const focusTop = useCallback((rowsNow = latest.current.rows) => {
    if (!rowsNow.length) { setRail(true); return }
    setFocus(f => ({ ...f, row: 0 }))
    focusDom(0, rowsNow[0].id === 'featured' ? latest.current.focus.featured : 0)
  }, [])

  const onFocusCard = useCallback((row: number, i: number) => {
    setInRows(true)
    setHeroN(n => n + 1)
    setFocus(f => {
      const r = latest.current.rows[row]
      if (!r) return f
      if (r.id === 'featured') return f.row === row && f.featured === i ? f : { ...f, row, featured: i }
      return f.row === row && f.at[r.id] === i ? f : { ...f, row, at: { ...f.at, [r.id]: i } }
    })
  }, [])

  // ---------- Applying a Home ----------

  /** Everything redrawn: focus on the pinned row and card, else the first row. */
  const applyFull = useCallback((json: string, pin?: Pin) => {
    const home = feed.parse(json)
    if (!home) return
    const old = latest.current.rows
    shownJson.current = json
    shownFor.current = profiles.currentId()
    pending.current = null
    // A profile's first Home, still being set up on the server (it comes on its own, by the refresh).
    if (home.building) setStatus(home.rows.length ? `Setting up the rest of ${pageName()}…` : `Setting up ${pageName()}…`, true, home.rows.length > 0)
    // (A page with nothing on it, not being set up: said, not a blank screen.)
    else setStatus(home.rows.length ? '' : 'Nothing here yet.')
    if (pin && old.length && ids(old) === ids(home.rows)) {
      // Same rows: updated in place, focus stays (each row's card followed by its id).
      setRows(home.rows)
      setFocus(f => ({ ...f, at: remap(old, home.rows, f.at) }))
      return
    }
    setRows(home.rows)
    let row = 0, card = 0
    if (pin) {
      const r = home.rows.findIndex(x => x.id === pin.row)
      if (r >= 0) { row = r; card = Math.max(0, home.rows[r].items.findIndex(x => x.id === pin.card)) }
    }
    const at: Record<string, number> = {}
    if (home.rows[row] && home.rows[row].id !== 'featured') at[home.rows[row].id] = card
    setFocus({ row, at, featured: home.rows[row]?.id === 'featured' ? Math.min(card, home.rows[row].items.length - 1) : 0 })
    if (home.rows.length) focusDom(row, card)
  }, [])

  /** A fresh Home while someone's browsing: the carousel and the row in focus keep their
   * cards if theirs changed (the fresh Home waits); rows above the focused one must be unchanged. */
  const applyWhileBrowsing = useCallback((json: string) => {
    const home = feed.parse(json)
    if (!home) return
    const { rows: old, focus: f } = latest.current
    const focusedId = inRowsRef.current ? old[f.row]?.id : undefined
    let waits = false
    const merged = home.rows.map(r => {
      if (r.id !== 'featured' && r.id !== focusedId) return r
      const was = old.find(o => o.id === r.id)
      if (was && cardIds(was) !== cardIds(r)) { waits = true; return was }
      return r
    })
    if (ids(old) !== ids(merged)) {
      const k = focusedId ? old.findIndex(r => r.id === focusedId) : -1
      const sameAbove = k >= 0 && ids(old.slice(0, k + 1)) === ids(merged.slice(0, k + 1))
      if (!sameAbove) { pending.current = json; return }
    }
    shownJson.current = json
    pending.current = waits ? json : null
    setRows(merged)
    setFocus(x => ({ ...x, at: remap(old, merged, x.at) }))
  }, [])
  /** A downloaded Home. */
  const deliver = useCallback((json: string, gen: number, pin?: Pin) => {
    if (gen !== generation.current) return
    if (changesSaving.current > 0 && feed.parse(json)?.stale) return
    if (pin) return applyFull(json, pin)
    if (json === shownJson.current) { freshStart.current = false; return }
    // Back after a long while (a night's sleep): the fresh Home in full, not held.
    if (freshStart.current) { freshStart.current = false; return applyFull(json, pinOf()) }
    // The first Home was still being set up (only Continue watching): the full one replaces it, focus
    // staying on the card it was on.
    if (shownBuilding()) return applyFull(json, pinOf())
    if (shownJson.current) return applyWhileBrowsing(json)
    applyFull(json)
  }, [])

  /** Whether the Home on screen is a first one still being set up. */
  const shownBuilding = () => !!shownJson.current && !!feed.parse(shownJson.current)?.building

  /** Asking again: while nothing could be shown, or a first Home's setting up failed. Only while Home is
   * in front (it's asked again on coming back). */
  const retryIn = (ms: number) => {
    clearTimeout(retry.current)
    retry.current = setTimeout(() => {
      if (frontRef.current && (!shownJson.current || shownBuilding())) refresh()
    }, ms)
  }
  useEffect(() => { if (!front) clearTimeout(retry.current) }, [front])

  /** From the server: then, if stale, built again. */
  const refresh = useCallback((pin?: Pin) => {
    clearTimeout(retry.current)
    const gen = generation.current
    lastFetch.current = Date.now()
    seenChange.current = api.changedAt
    const p = pageRef.current
    feed.download(p).then(json => {
      deliver(json, gen, pin)
      // (As any background update: never pulling focus.)
      if (feed.parse(json)?.stale) feed.refresh(p).then(j => {
        setupRetryMs.current = SETUP_RETRY_FIRST_MS
        deliver(j, gen)
      }, () => {
        // A first Home still being set up: asked again, less often each time, not left "Setting up…"
        // for good.
        if (gen !== generation.current || !shownBuilding()) return
        retryIn(setupRetryMs.current)
        setupRetryMs.current = Math.min(setupRetryMs.current * 2, SETUP_RETRY_MAX_MS)
      })
    }, () => {
      freshStart.current = false
      if (shownJson.current) return
      setStatus("Nightcap can't connect right now. Trying again…", true)
      retryIn(RETRY_MS)
    })
  }, [])
  useEffect(() => () => clearTimeout(retry.current), [])

  // The TV slept with Home in front (away a long while): the next Home is shown in full.
  useEffect(() => {
    let hiddenAt = 0
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') { hiddenAt = frontRef.current ? Date.now() : 0; return }
      if (hiddenAt && Date.now() - hiddenAt >= SLEPT_MS && shownJson.current) freshStart.current = true
      hiddenAt = 0
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  const pinOf = (): Pin | undefined => {
    const { rows: r, focus: f } = latest.current
    const row = r[f.row]
    if (!row || !inRowsRef.current) return undefined
    const i = row.id === 'featured' ? f.featured : f.at[row.id] ?? 0
    return { row: row.id, card: row.items[i]?.id ?? '' }
  }

  // ---------- Coming to the front ----------

  /** Everything shown afresh (another profile, or another of Home's pages): its own last copy at once
   * (or "Loading…"), then the server's. */
  const showAnew = () => {
    generation.current++
    shownJson.current = null
    pending.current = null
    setRows([])
    const kept = feed.cached(pageRef.current)
    if (kept) applyFull(kept)
    else setStatus(`Loading ${pageName()}…`, true)
    shownFor.current = profiles.currentId()
    refresh()
  }

  /** Home or one of its pages, in place: the page's own rows, its last saved copy at once, then fresh.
   * The same one again: back to its first row. */
  const showPage = (next: feed.Page) => {
    setRail(false)
    if (next === pageRef.current) return focusTop()
    pageRef.current = next
    setPage(next)
    showAnew()
  }

  useOnFront(() => {
    if (profiles.shouldAsk()) { askWhoIsWatching(nav.push); return }
    // The side panel's Home (or Shows, or Movies) from another screen: the panel closes, focus on the
    // first row.
    const asked = takeHomeAsked()
    if (asked) {
      setRail(false)
      const want = asked === 'home' ? null : asked
      if (want !== pageRef.current) { pageRef.current = want; setPage(want); return showAnew() }
      focusTop()
    }
    if (shownFor.current !== profiles.currentId()) return showAnew()
    if (pending.current) applyFull(pending.current, pinOf())
    if (api.changedAt > seenChange.current) refresh(pinOf())
    else if (Date.now() - lastFetch.current > REFETCH_AFTER_MS) refresh()
    // Still nothing to show, or a first Home still setting up: asked again now (not right after a
    // fetch: the first start's own).
    else if ((!shownJson.current || shownBuilding()) && Date.now() - lastFetch.current > RETRY_MS) refresh()
  })

  // ---------- The featured carousel ----------

  const featuredRow = rows[0]?.id === 'featured' ? rows[0] : undefined
  const flip = useCallback((by: number) => {
    const r = latest.current.rows[0]
    if (!r || r.id !== 'featured') return
    const n = r.items.length
    const next = (((latest.current.focus.featured + by) % n) + n) % n
    featuredShownAt.current = Date.now()
    setFocus(f => ({ ...f, featured: next }))
    setHeroN(x => x + 1)
  }, [])
  const dotsFocused = front && inRows && focus.row === 0 && !!featuredRow && !rail && !menu
  // (A trailer showing holds the carousel; its time starts again when the trailer goes.)
  const trailerOn = useRef(false)
  const onTrailer = useCallback((on: boolean) => { trailerOn.current = on; if (!on) featuredShownAt.current = Date.now() }, [])
  useEffect(() => {
    if (!dotsFocused) return
    featuredShownAt.current = Date.now()
    const t = setInterval(() => {
      if (trailerOn.current) featuredShownAt.current = Date.now()
      else if (Date.now() - featuredShownAt.current >= FEATURED_EVERY_MS) flip(1)
    }, 1000)
    return () => clearInterval(t)
  }, [dotsFocused])

  // ---------- Opening and long-press menus ----------

  const open = (rowIndex: number, i: number) => {
    const row = latest.current.rows[rowIndex]
    const it = row?.items[i]
    if (!row || !it) return
    if (it.type === 'tile') {
      api.send('/launcher/opened', { row: row.id })
      return nav.push(<Title kind="browse" id={it.id} name={it.name} />)
    }
    // (A report: no page changes because of it.)
    api.send('/launcher/interaction', {
      id: it.id, kind: 'opened', origin: row.id === 'continue' ? 'continue' : 'row', row: row.id, slot: i,
      ...(row.requestId ? { requestId: row.requestId } : {}), ...(row.modelVersion ? { modelVersion: row.modelVersion } : {}),
    })
    nav.push(<Title kind={it.type === 'series' ? 'series' : 'movie'} id={it.id} name={it.name}
      source={{ origin: row.id === 'continue' ? 'continue' : 'row', row: row.id, slot: i, requestId: row.requestId, modelVersion: row.modelVersion }} />)
  }

  /** A change from Home: shown and said at once (in place, no redraw), saved in the
   * background, then the server's Home brought up to date with it goes in, in place (as any background
   * update: nothing redraws or moves). The Home saved before the change isn't shown meanwhile: it would
   * put back what was just changed. If it couldn't be saved, Home as the server has it: this change
   * undone, any other kept. */
  const change = (edit: (rows: Row[]) => Row[], job: () => Promise<unknown>, done: string, pin: Pin) => {
    const startedAt = ++generation.current
    const who = profiles.currentId()
    const p = pageRef.current
    // (A Home held back from before the change would undo it when shown.)
    pending.current = null
    lastFetch.current = Date.now()
    changesSaving.current++
    const { rows: was, focus: f } = latest.current
    const now = edit(was)
    setRows(now)
    // Focus stays in the same slot: on whichever card now sits there.
    const r = now.findIndex(x => x.id === pin.row)
    if (r < 0) focusTop(now)
    else {
      const i = Math.min(f.at[pin.row] ?? 0, now[r].items.length - 1)
      setFocus(x => ({ ...x, row: r, at: { ...x.at, [pin.row]: i } }))
      focusDom(r, i)
    }
    notify(done)
    job().then(() => {
      seenChange.current = api.changedAt
      feed.refresh(p).then(json => json, () => null).then(json => {
        changesSaving.current--
        // (A later change wins: its own refresh follows. Not brought up to date: what's shown stays;
        // the next refresh catches up.)
        if (startedAt !== generation.current || who !== profiles.currentId() || p !== pageRef.current || !json) return
        // (A first Home still being set up: the full one replaces it, and its "Setting up…" goes.)
        if (shownBuilding()) applyFull(json, pinOf())
        else applyWhileBrowsing(json)
      })
    }, () => {
      changesSaving.current--
      seenChange.current = api.changedAt
      notify("Couldn't save that. Try again.")
      generation.current++
      refresh(pinOf() ?? pin)
    })
  }

  /** Puts a title first in the My List row (in place), or makes the row, right after Continue watching.
   * (Home only: the Shows and Movies pages have no My List. One in Continue watching isn't shown in My
   * List: it's there already, as the server has it.) */
  const addToMyList = (it: Item) => (rs: Row[]): Row[] => {
    if (pageRef.current || rs.some(r => r.id === 'continue' && r.items.some(x => x.id === it.id))) return rs
    const k = rs.findIndex(r => r.id === 'mylist')
    if (k >= 0) return rs[k].items.some(x => x.id === it.id) ? rs : rs.map((r, i) => (i === k ? { ...r, items: [it, ...r.items] } : r))
    const c = rs.findIndex(r => r.id === 'continue')
    const at = (c >= 0 ? c : rs.findIndex(r => r.id === 'featured')) + 1
    return [...rs.slice(0, at), { id: 'mylist', title: 'My List', items: [it] }, ...rs.slice(at)]
  }

  const menuFor = (rowIndex: number, i: number): Menu | null => {
    const row = latest.current.rows[rowIndex]
    const it = row?.items[i]
    if (!row || !it || row.id === 'featured') return null
    const pin = { row: row.id, card: it.id }
    const watched = (on: boolean) => () => api.post('/launcher/watched', { type: it.type, id: it.videoId ?? it.id, watched: on })
    if (row.id === 'continue') {
      const series = it.type === 'series'
      const ep = it.episode
      const choices: Choice[] = [
        {
          icon: 'act_watched', label: series ? (ep ? `Mark ${ep} as watched` : 'Mark episode as watched') : 'Mark as watched',
          run: () => change(rs => editRow(rs, 'continue', items => items.flatMap(x => {
            if (x.id !== it.id) return [x]
            if (!series || !x.nextVideoId) return []
            return [{ ...x, videoId: x.nextVideoId, episode: x.nextEpisode, progress: undefined, nextVideoId: undefined, nextEpisode: undefined }]
          })), watched(true), series ? (ep ? `${ep} marked as watched` : 'This episode marked as watched') : `${it.name} marked as watched`, pin),
        },
        {
          icon: 'act_unwatched', label: series ? (ep ? `Mark ${ep} as unwatched` : 'Mark episode as unwatched') : 'Mark as unwatched',
          run: () => change(rs => editRow(rs, 'continue', items => items.flatMap(x => (x.id !== it.id ? [x] : series ? [{ ...x, progress: undefined }] : []))),
            watched(false), series ? (ep ? `${ep} marked as unwatched` : 'This episode marked as unwatched') : `${it.name} marked as unwatched`, pin),
        },
      ]
      if (series) {
        const on = !!it.muted
        choices.push({
          icon: on ? 'act_bell' : 'act_bell_off', label: on ? 'Tell me about new episodes' : "Don't tell me about new episodes",
          run: () => change(rs => editRow(rs, 'continue', items => items.map(x => (x.id !== it.id ? x : { ...x, muted: !on, newEpisodes: on ? x.newEpisodes : undefined }))),
            () => api.post('/launcher/notify', { id: it.id, on }),
            on ? `You'll hear about new episodes of ${it.name}` : `No more new-episode alerts for ${it.name}`, pin),
        })
      }
      return { title: it.name, subtitle: series ? ep : it.year, choices }
    }
    if (it.type !== 'movie' && it.type !== 'series') return null
    const kind = [it.type === 'series' ? 'Series' : 'Film', it.year].filter(Boolean).join('  ·  ')
    const myList = (on: boolean) => () => api.post('/launcher/mylist', { id: it.id, type: it.type, on })
    // My List: taking it off (it leaves that row only; the row goes if it's left empty).
    if (row.id === 'mylist') {
      return {
        title: it.name, subtitle: kind,
        choices: [{
          icon: 'act_close', label: 'Remove from My List',
          run: () => change(rs => editRow(rs, 'mylist', items => items.filter(x => x.id !== it.id)), myList(false), `${it.name} removed from My List`, pin),
        }],
      }
    }
    // Gone from every row but the Top 10 (a chart keeps its ranks), empty rows with it.
    const drop = (keepInMyList = false) => (rs: Row[]) => rs.map(r => (r.id === 'top10' || r.style === 'ranked' || (keepInMyList && r.id === 'mylist') ? r
      : { ...r, items: r.items.filter(x => x.id !== it.id) })).filter(r => r.items.length)
    return {
      title: it.name,
      subtitle: kind,
      choices: [
        { icon: 'act_watched', label: 'Mark as watched', run: () => change(drop(it.type === 'series'), watched(true), `${it.name} marked as watched`, pin) },
        {
          icon: 'act_not_interested', label: 'Not interested',
          run: () => change(drop(), () => api.post('/launcher/hide', { id: it.id, kind: 'notInterested', hidden: true, name: it.name, type: it.type }),
            `You won't see ${it.name} again`, pin),
        },
        // (In My List at once; it stays in the other rows too. A show marked watched stays on My List,
        // a film leaves it, as the server does.)
        { icon: 'add', label: 'Add to My List', run: () => change(addToMyList(it), myList(true), `${it.name} added to My List`, pin) },
      ],
    }
  }

  // OK: a short press opens, a long one (500 ms) opens the menu. Remotes send OK going down, then
  // (while held) again and again, then up.
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; row: number; i: number; long: boolean } | null>(null)
  useEffect(() => {
    const up = (e: KeyboardEvent) => {
      if (e.keyCode !== 13 && e.key !== 'Enter') return
      const p = press.current
      if (!p) return
      press.current = null
      clearTimeout(p.timer)
      if (!p.long) open(p.row, p.i)
    }
    window.addEventListener('keyup', up)
    return () => window.removeEventListener('keyup', up)
  }, [])

  // ---------- The remote ----------

  const moveRow = (to: number) => {
    const { rows: rs, focus: f } = latest.current
    if (to < 0 || to >= rs.length) return
    const r = rs[to]
    const i = r.id === 'featured' ? f.featured : Math.min(f.at[r.id] ?? 0, r.items.length - 1)
    focusDom(to, i)
  }

  // The trailer sound button: Up from the top row; Down or Back go back to the card that
  // had focus; Left, Right and Up stay on it.
  const soundButton = useRef<HTMLButtonElement>(null)
  const beforeSound = useRef<HTMLElement | null>(null)

  useKeys((key, e) => {
    if (rail || menu) return
    // An arrow held down moves along at a steady pace (a step each HELD_STEP_MS), rather than as fast
    // as the remote repeats: each step brings in a row's cards, and a burst of them froze Home.
    if (e.repeat && (key === 'up' || key === 'down' || key === 'left' || key === 'right')) {
      const now = Date.now()
      if (now - lastHeldStep.current < HELD_STEP_MS) return true
      lastHeldStep.current = now
    }
    // No rows yet (can't connect, still loading): Left still opens the side menu (Settings…).
    if (key === 'left' && !latest.current.rows.length) { setRail(true); return true }
    const active = document.activeElement as HTMLElement | null
    if (active && active === soundButton.current) {
      if (key === 'ok') { if (!e.repeat) active.click(); return true }
      if (key === 'down' || key === 'back') {
        const was = beforeSound.current
        if (!(was && was.isConnected && focusEl(was))) moveRow(0)
        return true
      }
      return true
    }
    const onCard = !!active?.dataset.row && root.current?.contains(active)
    // On Shows or Movies, Back is Home; on Home, back to its top.
    if (key === 'back') { if (pageRef.current) showPage(null); else focusTop(); return true }
    if (!onCard) return
    const rowIndex = Number(active!.dataset.row), i = Number(active!.dataset.i)
    const row = latest.current.rows[rowIndex]
    if (!row) return
    const featured = row.id === 'featured'
    switch (key) {
      case 'up':
        if (rowIndex === 0) { beforeSound.current = active; focusEl(soundButton.current) }
        else moveRow(rowIndex - 1)
        return true
      case 'down': moveRow(rowIndex + 1); return true
      case 'left':
        if (featured) { if (latest.current.focus.featured === 0) setRail(true); else flip(-1); return true }
        if (i === 0) setRail(true)
        else focusDom(rowIndex, i - 1)
        return true
      case 'right':
        if (featured) { flip(1); return true }
        if (i < row.items.length - 1) focusDom(rowIndex, i + 1)
        return true
      case 'ok': {
        if (e.repeat || press.current) return true
        const it = featured ? row.items[latest.current.focus.featured] : row.items[i]
        const at = featured ? latest.current.focus.featured : i
        if (!menuFor(rowIndex, at)) { open(rowIndex, at); return true }
        const p = { row: rowIndex, i: at, long: false, timer: setTimeout(() => {
          p.long = true
          const m = menuFor(rowIndex, at)
          if (m && it) setMenu(m)
        }, LONG_PRESS_MS) }
        press.current = p
        return true
      }
    }
  })

  const pickRail = (entry: Entry) => {
    if (entry === 'home' || entry === 'shows' || entry === 'movies') return showPage(entry === 'shows' ? 'tv' : entry === 'movies' ? 'movie' : null)
    if (entry === 'profile') return nav.push(<Profiles fromMenu />)
    nav.push(entry === 'search' ? <Search /> : entry === 'live' ? <LiveTv /> : <Settings />)
  }

  // ---------- Drawing ----------

  const row = rows[focus.row]
  const index = row ? (row.id === 'featured' ? focus.featured : Math.min(focus.at[row.id] ?? 0, row.items.length - 1)) : 0
  const item: Item | undefined = row?.items[index]

  return (
    <div ref={root} className="home">
      <Backdrop item={inRows ? item : featuredRow?.items[focus.featured]} active={front && !menu} onTrailer={onTrailer}
        neighbours={row ? [row.items[index - 1], row.items[index + 1]] : []} onShown={setBackdrop} />
      <div className={`dims${rail ? ' dim' : ''}`} data-inert={rail || menu ? '' : undefined}>
        <span className={`home-hint${rail ? ' hidden' : ''}`}>‹  Home</span>
        <Clock />
        {row && item && <HeroText row={row} item={item} n={heroN} />}
        <Rows rows={rows} focus={focus} onFocusCard={onFocusCard} onPick={(r, i) => { if (!menuFor(r, i)) open(r, i) }} />
      </div>
      <Widgets active={front} backdrop={backdrop} soundRef={soundButton} />
      {status && <p className={`home-status${status.low ? ' low' : ''}${status.waiting ? ' waiting' : ''}`} role="status">{status.text}</p>}
      <Rail open={rail} page={page === 'tv' ? 'shows' : page === 'movie' ? 'movies' : 'home'} onClose={() => setRail(false)} onPick={pickRail} />
      {menu && <Sheet title={menu.title} subtitle={menu.subtitle} choices={menu.choices} onClose={() => setMenu(null)} />}
    </div>
  )
}

/** Each row's remembered card follows the same card id, else stays at its index (clamped). */
function remap(old: Row[], fresh: Row[], at: Record<string, number>) {
  const out: Record<string, number> = {}
  for (const r of fresh) {
    const was = old.find(o => o.id === r.id)
    const i = at[r.id]
    if (i == null) continue
    const id = was?.items[i]?.id
    const found = id ? r.items.findIndex(x => x.id === id) : -1
    out[r.id] = found >= 0 ? found : Math.min(i, r.items.length - 1)
  }
  return out
}

function editRow(rows: Row[], id: string, edit: (items: Item[]) => Item[]) {
  return rows.map(r => (r.id === id ? { ...r, items: edit(r.items) } : r)).filter(r => r.items.length)
}
