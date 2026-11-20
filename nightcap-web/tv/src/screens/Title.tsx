import { useCallback, useEffect, useRef, useState } from 'react'
import * as api from '../api'
import { useIsFront, useKeys, useNav, useOnFront } from '../nav'
import * as pages from '../pages'
import type { Card, Header, Kind, Page } from '../pages'
import { CardRows, useCardRows, type RowOf } from '../ui/CardRows'
import { notify } from '../ui/Notice'
import Rail, { homePage, type Entry } from '../ui/Rail'
import Sheet, { type Choice } from '../ui/Sheet'
import LiveTv from './LiveTv'
import Profiles from './Profiles'
import Search from './Search'
import Player from '../player/Player'
import Settings from './Settings'
import '../home/Home.css'
import './Title.css'
import PosterImg from '../ui/PosterImg'

// Title, person and Browse pages: a header (backdrop
// top right, the details box top left, following the focused card), then rows: seasons of
// episodes, the cast, "More like this", a person's "Known for", a Browse page's rows. OK opens
// (or plays); holding OK opens the card's menu; changes show at once.

export type Source = { origin: string; row?: string; slot?: number; requestId?: string; modelVersion?: string }

type Menu = { title: string; subtitle?: string; choices: Choice[] }
const RATINGS: Record<string, string> = { '-1': 'Not for me', '1': 'I like it', '2': 'Love it' }
const RETRIES = 3

export default function Title({ kind, id, name, source = { origin: 'direct' } }: {
  kind: Kind; id: string; name: string; source?: Source
}) {
  const nav = useNav()
  const front = useIsFront()
  const root = useRef<HTMLDivElement>(null)
  const [page, setPage] = useState<Page | null>(null)
  const [similar, setSimilar] = useState<Card[] | null>(null)
  // (The AI's answer More like this came from, sent back with what's opened from it.)
  const similarRequest = useRef<string | undefined>(undefined)
  const [status, setStatus] = useState('Loading…')
  const [failed, setFailed] = useState(false)
  const [rail, setRail] = useState(false)
  const [menu, setMenu] = useState<Menu | null>(null)
  const [focused, setFocused] = useState(false)
  const [cardBackdrop, setCardBackdrop] = useState<string | null>(null)
  const seenChange = useRef(api.changedAt)
  const latestPage = useRef(page)
  latestPage.current = page
  const isTitle = kind === 'movie' || kind === 'series'
  const path = pages.pagePath(kind, id)

  // The rows: the page's sections, then "More like this" (title pages).
  const rows: RowOf<Card>[] = page ? [...page.sections] : []
  if (page && isTitle && similar?.length) rows.push({ id: 'similar', title: 'More like this', kind: 'posters', items: similar })

  const r = useCardRows({
    root, rows, front: front && !menu && !rail,
    onOpen: (row, i) => open(row, i), hasMenu: (row, i) => !!menuFor(row, i), onMenu: (row, i) => setMenu(menuFor(row, i)),
    onLeftEdge: () => setRail(true),
  })

  // ---------- Loading ----------

  const draw = useCallback((p: Page, keepCard?: string | null) => {
    setPage(p)
    setStatus('')
    setFailed(false)
    const sections = p.sections
    let row = 0, i = 0
    const byId = keepCard ? sections.findIndex(s => s.items.some(c => c.id === keepCard)) : -1
    if (byId >= 0) { row = byId; i = sections[byId].items.findIndex(c => c.id === keepCard) }
    else if (!keepCard && p.focus) {
      const s = sections.findIndex(x => x.id === p.focus!.section)
      if (s >= 0) { row = s; i = Math.min(p.focus.index, sections[s].items.length - 1) }
    }
    r.setFocus(f => ({ row, at: { ...(keepCard ? f.at : {}), ...(sections[row] ? { [sections[row].id]: Math.max(0, i) } : {}) } }))
    if (sections.length) r.focusCard(row, Math.max(0, i))
  }, [])

  const load = useCallback((fresh: boolean, keepCard?: string | null) => {
    let attempt = 0
    const go = () => {
      attempt++
      // (Browse pages are always fresh: the server leaves out what's been watched since. A title's page
      // too: what was watched since (here, on Home, on the phone) shows. Retries too.)
      pages.get<Page>(path, fresh || attempt > 1 || kind === 'browse' || isTitle).then(p => {
        seenChange.current = api.changedAt
        draw(p, keepCard)
      }, () => {
        if (attempt < RETRIES) return void setTimeout(go, 2000 * attempt)
        if (!latestPage.current) { setStatus("This page isn't available right now. Press OK to try again."); setFailed(true) }
      })
    }
    go()
  }, [path])

  // More like this: the list, then the AI's ranking of it in the background.
  const loadSimilar = () => {
    if (kind !== 'movie' && kind !== 'series') return
    const simPath = pages.similarPath(kind, id)
    pages.get<{ items: Card[]; ai?: boolean; requestId?: string }>(simPath).then(s => {
      setSimilar(s.items ?? [])
      similarRequest.current = s.requestId
      if (s.ai) return
      api.call<{ items: Card[]; ai?: boolean; requestId?: string }>(`/launcher/similar/${kind}/${encodeURIComponent(id)}/rank`, { body: {}, timeout: api.TIMEOUT.slow })
        .then(ranked => {
          pages.remember(simPath, ranked)
          // (Not while it has focus: nothing moves under the viewer. Its AI answer goes with the list shown.)
          if (rowsRef.current[focusRef.current.row]?.id === 'similar') return
          setSimilar(ranked.items ?? [])
          similarRequest.current = ranked.requestId
        }, () => {})
    }, () => {})
  }

  useEffect(() => {
    load(false)
    loadSimilar()
  }, [])
  const rowsRef = useRef(rows)
  rowsRef.current = rows
  const focusRef = useRef(r.focus)
  focusRef.current = r.focus

  // Coming back: a title page reloads if anything changed, and
  // again whenever a change lands while it's in front (the player's last save comes after this page
  // is back).
  const firstFront = useRef(true)
  useOnFront(() => {
    if (firstFront.current) { firstFront.current = false; return }
    setCardBackdrop(null)
    catchUp()
  })
  useEffect(() => (front ? api.whenChanged(() => catchUp()) : undefined), [front])

  /** This page's own saves under way: each reloads the page itself, focus kept on the card acted on. */
  const saving = useRef(0)
  /** One of this page's own saves is done: the change it made is caught up with. */
  const saved = () => {
    saving.current--
    seenChange.current = api.changedAt
  }

  const catchUp = () => {
    const before = latestPage.current
    if (!isTitle || !before || saving.current > 0 || api.changedAt <= seenChange.current) return
    seenChange.current = api.changedAt
    pages.get<Page>(path, true).then(fresh => {
      if (gone.current) return
      // The player moved you on (the next episode, another season): focus follows it.
      const moved = focusCardId(fresh) !== focusCardId(before)
      draw(fresh, moved ? focusCardId(fresh) ?? null : focusedCard())
    }, () => {})
  }
  const gone = useRef(false)
  useEffect(() => () => { gone.current = true }, [])

  const focusedCard = () => {
    const row = rowsRef.current[focusRef.current.row]
    return row?.items[Math.min(focusRef.current.at[row.id] ?? 0, row.items.length - 1)]?.id ?? null
  }

  // ---------- Opening ----------

  const open = (rowIndex: number, i: number) => {
    const p = latestPage.current
    const row = rowsRef.current[rowIndex]
    const c = row?.items[i]
    if (!p || !row || !c) return
    if (row.kind === 'episodes') {
      if (c.upcoming) return notify(c.aired ? `Not out yet. ${c.id.includes(':') ? 'Arrives' : 'Comes out'} ${pages.niceDate(c.aired)}` : 'Not out yet')
      const parts = c.id.split(':')
      const episode = parts.length === 3 ? `S${parts[1]} E${parts[2]}  ·  ${c.name}` : undefined
      return nav.push(<Player type={p.header.type === 'series' ? 'series' : 'movie'} id={c.id} name={p.header.name} episode={episode}
        art={p.header.backdrop ?? undefined} source={source} />)
    }
    if (row.kind === 'cast') return nav.push(<Title kind="person" id={c.id} name={c.name} />)
    // A title from this page's rows (More like this, an actor's or a Browse page's titles), as the
    // Android TV's: More like this with the AI's answer it came from. (A report: no page changes.)
    const from: Source = row.id === 'similar' ? { origin: 'similar', row: 'similar', slot: i, requestId: similarRequest.current }
      : { origin: 'row', row: kind === 'browse' ? `${id}/${row.id}` : row.id, slot: i }
    api.send('/launcher/interaction', { id: c.id, kind: 'opened', ...from })
    nav.push(<Title kind={(c.type ?? 'movie') as Kind} id={c.id} name={c.name} source={from} />)
  }

  // ---------- Changes ----------

  /** Shown at once, sent, then the page fetched fresh (or put back if the server says no). */
  const change = (edit: (p: Page) => Page, job: () => Promise<unknown>, done: string, reload = true) => {
    const before = latestPage.current
    if (!before) return
    const card = focusedCard()
    setPage(edit(before))
    saving.current++
    job().then(() => {
      saved()
      notify(done)
      if (reload) load(true, card)
    }, () => {
      saved()
      notify("Couldn't save that. Try again.")
      setPage(before)
    })
  }

  const mark = (match: (sectionId: string, c: Card) => boolean, watched: boolean) => (p: Page): Page => ({
    ...p,
    sections: p.sections.map(s => ({ ...s, items: s.items.map(c => (match(s.id, c) ? { ...c, watched, progress: undefined } : c)) })),
  })

  const menuFor = (rowIndex: number, i: number): Menu | null => {
    const p = latestPage.current
    const row = rowsRef.current[rowIndex]
    const c = row?.items[i]
    if (!p || !row || !c) return null
    const h = p.header
    if (row.kind === 'cast') return null
    if (row.kind === 'posters') {
      const title = c.name
      // Gone at once: from "More like this" only, else from every row. Focus goes to its
      // neighbour in the row, or, the row gone, to the next row's first card.
      const drop = () => {
        const at = row.items.findIndex(x => x.id === c.id)
        const left = row.items.filter(x => x.id !== c.id)
        const next = left[Math.min(Math.max(0, at), left.length - 1)]?.id
          ?? rowsRef.current.slice(rowIndex + 1).map(rw => rw.items.find(x => x.id !== c.id)).filter(Boolean)[0]?.id
        const pg = latestPage.current ?? p
        const sections = row.id === 'similar' ? pg.sections
          : pg.sections.map(s => ({ ...s, items: s.items.filter(x => x.id !== c.id) })).filter(s => s.items.length)
        const sim = row.id === 'similar' ? (similar ?? []).filter(x => x.id !== c.id) : similar
        if (row.id === 'similar') setSimilar(sim)
        else setPage({ ...pg, sections })
        const after: RowOf<Card>[] = [...sections]
        if (isTitle && sim?.length) after.push({ id: 'similar', title: 'More like this', kind: 'posters', items: sim })
        const ri = next ? after.findIndex(rw => rw.items.some(x => x.id === next)) : -1
        if (ri < 0) return
        const ci = after[ri].items.findIndex(x => x.id === next)
        r.setFocus(f => ({ row: ri, at: { ...f.at, [after[ri].id]: ci } }))
        r.focusCard(ri, ci)
      }
      const undo = { page: p, similar }
      const act = (job: () => Promise<unknown>, done: string) => {
        drop()
        saving.current++
        job().then(() => {
          saved()
          // (The More like this lists kept here would bring it back.)
          pages.forgetSimilar()
          notify(done)
        }, () => {
          saved()
          notify("Couldn't save that. Try again.")
          setPage(undo.page)
          setSimilar(undo.similar)
        })
      }
      return {
        title, subtitle: [c.type === 'series' ? 'Series' : 'Film', c.year].filter(Boolean).join('  ·  '),
        choices: [
          { icon: 'act_watched', label: 'Mark as watched', run: () => act(() => api.post('/launcher/watched', { type: c.type, id: c.id, watched: true }), `${title} marked as watched`) },
          { icon: 'act_not_interested', label: 'Not interested', run: () => act(() => api.post('/launcher/hide', { id: c.id, kind: 'notInterested', hidden: true, name: c.name, type: c.type }), `You won't see ${title} again`) },
          // (Always Add: these cards don't say what's on the list; adding twice is harmless. Nothing on
          // the page changes; held as a save, so the page isn't fetched again meanwhile.)
          ...(c.type !== 'movie' && c.type !== 'series' ? [] : [{
            icon: 'add' as const, label: 'Add to My List',
            run: () => {
              saving.current++
              api.post('/launcher/mylist', { id: c.id, type: c.type, on: true }).then(
                () => { saved(); notify(`${title} added to My List`) },
                () => { saved(); notify("Couldn't save that. Try again.") })
            },
          }]),
        ],
      }
    }
    // An episode or a film's Watch card.
    const series = h.type === 'series'
    const label = series ? (c.episode ?? 'Episode') : h.name
    const choices: Choice[] = []
    const one = (watched: boolean) => () => change(mark((_, x) => x.id === c.id, watched),
      () => api.post('/launcher/watched', { type: h.type, id: c.id, watched }), `${label} marked as ${watched ? 'watched' : 'unwatched'}`)
    // (Not out yet: nothing to mark; alerts and rating still.)
    if (!c.watched && !c.upcoming) choices.push({ icon: 'act_watched', label: 'Mark as watched', run: one(true) })
    if ((c.watched || (c.progress ?? 0) > 0.01) && !c.upcoming) choices.push({ icon: 'act_unwatched', label: 'Mark as unwatched', run: one(false) })
    if (series) {
      const season = /^s(\d+)$/.exec(row.id)
      const real = (sid: string) => /^s([1-9]\d*)$/.test(sid)
      if (season && real(row.id)) {
        const n = season[1]
        const aired = row.items.filter(x => !x.upcoming)
        const seasonMark = (watched: boolean) => () => change(mark((sid, x) => sid === row.id && !x.upcoming, watched),
          () => api.post('/launcher/watched', { type: 'series', id: h.id, watched, season: Number(n) }), `Season ${n} marked as ${watched ? 'watched' : 'unwatched'}`)
        if (aired.some(x => !x.watched)) choices.push({ icon: 'act_watched', label: `Mark Season ${n} as watched`, run: seasonMark(true) })
        if (aired.some(x => x.watched)) choices.push({ icon: 'act_unwatched', label: `Mark Season ${n} as unwatched`, run: seasonMark(false) })
      }
      if (p.sections.some(s => real(s.id) && s.items.some(x => !x.upcoming && !x.watched))) {
        choices.push({ icon: 'act_watched', label: 'Mark the whole show as watched', run: () => change(mark((sid, x) => real(sid) && !x.upcoming, true),
          () => api.post('/launcher/watched', { type: 'series', id: h.id, watched: true }), `${h.name} marked as watched`) })
      }
      const on = h.notify !== false
      choices.push({
        icon: on ? 'act_bell_off' : 'act_bell', label: on ? "Don't tell me about new episodes" : 'Tell me about new episodes',
        run: () => change(pg => ({ ...pg, header: { ...pg.header, notify: !on } }), () => api.post('/launcher/notify', { id: h.id, on: !on }),
          on ? `No more new-episode alerts for ${h.name}` : `You'll hear about new episodes of ${h.name}`),
      })
    }
    const mine = h.myRating
    choices.push({ icon: 'act_rate', label: mine != null ? `Your rating: ${RATINGS[String(mine)]}` : `Rate ${h.name}`, run: () => setTimeout(() => setMenu(ratingMenu(h)), 160) })
    // My List: like the rating, shown at once, put back if it couldn't be saved, no reload.
    const inList = !!h.inList
    choices.push({
      icon: inList ? 'act_close' : 'add', label: inList ? 'Remove from My List' : 'Add to My List',
      run: () => change(pg => ({ ...pg, header: { ...pg.header, inList: !inList } }), () => api.post('/launcher/mylist', { id: h.id, type: h.type, on: !inList }),
        inList ? `${h.name} removed from My List` : `${h.name} added to My List`, false),
    })
    return { title: series ? c.name : h.name, subtitle: series ? c.episode : h.facts, choices }
  }

  /** The rating menu: for the whole title; no reload. */
  const ratingMenu = (h: Header): Menu => {
    const rate = (value: -1 | 1 | 2 | null) => () => {
      const before = latestPage.current
      setPage(pg => pg && { ...pg, header: { ...pg.header, myRating: value } })
      saving.current++
      api.post('/launcher/rating', { id: h.id, value }).then(
        () => { saved(); notify(value == null ? 'Rating cleared' : `Rated: ${RATINGS[String(value)]}`) },
        () => { saved(); notify("Couldn't save that. Try again."); setPage(before) })
    }
    const tick = (v: number) => (h.myRating === v ? '✓  ' : '')
    const choices: Choice[] = [
      { icon: 'rate_down', label: `${tick(-1)}Not for me`, run: rate(-1) },
      { icon: 'rate_up', label: `${tick(1)}I like it`, run: rate(1) },
      { icon: 'rate_love', label: `${tick(2)}Love it`, run: rate(2) },
    ]
    if (h.myRating != null) choices.push({ icon: 'act_close', label: 'Clear my rating', run: rate(null) })
    return { title: h.name, subtitle: 'Your rating', choices }
  }

  // ---------- Keys ----------

  useKeys((key, e) => {
    if (rail || menu) return
    if (failed && key === 'ok') {
      setStatus('Loading…'); setFailed(false); load(true)
      // (More like this failed with it: asked again too.)
      if (!similar?.length) loadSimilar()
      return true
    }
    return r.onKey(key, e)
  })

  const pickRail = (entry: Entry) => {
    setRail(false)
    const page = homePage(entry)
    if (page) return nav.popToRoot(page)
    if (entry === 'profile') return nav.push(<Profiles fromMenu />)
    nav.push(entry === 'search' ? <Search /> : entry === 'live' ? <LiveTv /> : <Settings />)
  }

  // ---------- Drawing ----------

  const row = rows[r.focus.row]
  const card = row?.items[Math.min(r.focus.at[row.id] ?? 0, row.items.length - 1)]
  const details = page ? (focused && row && card ? cardDetails(page.header, row, card, kind) : headerDetails(page.header)) : null
  const backdrop = kind === 'browse' && focused ? cardBackdrop ?? page?.header.backdrop : page?.header.backdrop

  useEffect(() => {
    if (kind === 'browse' && card?.backdrop) { const t = setTimeout(() => setCardBackdrop(card.backdrop ?? null), 90); return () => clearTimeout(t) }
  }, [card])

  return (
    <div ref={root} className="home title-page" onFocus={() => setFocused(true)}>
      <div className="backdrop" aria-hidden>
        {backdrop && <img key={backdrop} className="backdrop-img" src={backdrop} alt="" />}
        <span className="scrim-left" />
        <span className="scrim-bottom" />
      </div>
      <div className={`dims${rail ? ' dim' : ''}`} data-inert={rail || menu ? '' : undefined}>
        <div key={`${r.focus.row}:${card?.id ?? ''}`} className="hero-text title-text">
          <span className="hero-eyebrow">{details?.eyebrow ?? ''}</span>
          <h1 className={`hero-title${(details?.title ?? name).length > 18 ? ' long' : ''}`}>{details?.title ?? name}</h1>
          {details?.meta && <span className="hero-meta">{details.meta}</span>}
          {details?.reason && <span className="hero-reason">{details.reason}</span>}
          {details?.overview && <span className="hero-overview">{details.overview}</span>}
        </div>
        {page && (
          <CardRows rows={rows} focus={r.focus} onFocusCard={r.onFocusCard} onPick={(rr, i) => { if (!menuFor(rr, i)) open(rr, i) }}
            card={(rw, c, _i, loadImg) => <PageCard row={rw} card={c} header={page.header} load={loadImg} />} />
        )}
      </div>
      {status && <p className={`home-status${status === 'Loading…' ? ' waiting' : ''}`} role="status">{status}</p>}
      <Rail open={rail} page="home" onClose={() => setRail(false)} onPick={pickRail} />
      {menu && <Sheet title={menu.title} subtitle={menu.subtitle} choices={menu.choices} onClose={() => setMenu(m => (m === menu ? null : m))} />}
    </div>
  )
}

/** The card the server says is the one to be on (the episode you're up to). */
function focusCardId(p: Page) {
  const f = p.focus
  return f ? p.sections.find(s => s.id === f.section)?.items[f.index]?.id : undefined
}

const ratingOf = (v?: number | string | null) => (v != null && Number(v) > 0 ? `★ ${Number(v).toFixed(1)}` : undefined)

function headerDetails(h: Header) {
  return {
    eyebrow: h.type === 'person' ? 'Cast' : h.type === 'browse' ? 'Browse' : h.type === 'series' ? 'Series' : 'Film',
    title: h.name, meta: [h.facts, ratingOf(h.rating)].filter(Boolean).join('  ·  '), reason: '', overview: h.overview,
  }
}

function cardDetails(h: Header, row: RowOf<Card>, c: Card, kind: Kind) {
  if (row.kind === 'cast') {
    return { eyebrow: 'Cast', title: c.name, meta: c.character ? `as ${c.character}` : '', reason: 'Press OK to see their films and series', overview: '' }
  }
  if (row.kind === 'episodes') {
    const when = c.upcoming ? (c.aired ? `Coming ${pages.niceDate(c.aired)}` : 'Coming soon') : c.aired ? `Aired ${pages.niceDate(c.aired)}` : undefined
    return {
      eyebrow: h.type === 'series' ? `${h.name} · ${row.title}` : h.name, title: c.name,
      meta: [c.episode, when, ratingOf(c.rating)].filter(Boolean).join('  ·  '), reason: '', overview: c.overview ?? '',
    }
  }
  return {
    eyebrow: kind === 'person' || kind === 'browse' ? `${h.name} · ${row.title}` : row.title, title: c.name,
    meta: [c.type === 'series' ? 'Series' : 'Film', c.year, ratingOf(c.rating)].filter(Boolean).join('  ·  '),
    reason: c.reason ? (kind === 'person' ? c.reason : `✦  ${c.reason}`) : '', overview: c.overview ?? '',
  }
}

/** A card on a page. */
function PageCard({ row, card: c, header: h, load }: { row: RowOf<Card>; card: Card; header: Header; load: boolean }) {
  const [broken, setBroken] = useState(false)
  const [backdropBroken, setBackdropBroken] = useState(false)
  if (row.kind === 'cast') {
    return (
      <span className="cast">
        <span className="cast-photo">{load && c.photo && <img src={c.photo} alt="" />}</span>
        <span className="cast-name">{c.name}</span>
        <span className="cast-character">{c.character}</span>
      </span>
    )
  }
  if (row.kind === 'episodes') {
    const parts = c.id.split(':')
    const n = parts.length === 3 ? `E${parts[2]}` : ''
    // (A film's Watch card: its own words; the Android TV's label there is a known slip.)
    const label = parts.length !== 3
      ? c.upcoming ? `Not out yet${c.aired ? `  ·  Comes out ${pages.niceDate(c.aired)}` : ''}`
        : [c.name, (c.progress ?? 0) > 0.01 ? `${Math.floor((c.progress ?? 0) * 100)}% watched` : ''].filter(Boolean).join('  ·  ')
      : c.upcoming ? `${n}  ·  ${c.aired ? `Coming ${pages.niceDate(c.aired, false)}` : 'Coming soon'}` : `${n}  ·  ${c.name}`
    // The episode's still, else the show's backdrop when it doesn't load; and when that doesn't either
    // (some shows have neither), no picture: a plain card, not a broken one.
    const fallback = c.upcoming || broken || !c.thumbnail
    const still = fallback ? (backdropBroken ? undefined : h.backdrop) : c.thumbnail
    return (
      <span className="still">
        {load && still && <img key={still} className={c.upcoming ? 'upcoming' : ''} src={still} alt="" onError={() => (fallback ? setBackdropBroken(true) : setBroken(true))} />}
        <span className="still-scrim" />
        <span className="still-label">{label}</span>
        {c.watched && <span className="chip watched">✓  Watched</span>}
        {(c.progress ?? 0) > 0.01 && <span className="progress"><span style={{ transform: `scaleX(${Math.min(1, c.progress ?? 0)})` }} /></span>}
        <span className="sheen" />
      </span>
    )
  }
  return (
    <span className="poster page-poster">
      {load && <PosterImg src={c.poster} name={c.name} />}
      <span className="sheen" />
    </span>
  )
}
