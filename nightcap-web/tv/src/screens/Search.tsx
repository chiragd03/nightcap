import { useEffect, useRef, useState } from 'react'
import * as api from '../api'
import { focus as focusEl } from '../focus'
import { useIsFront, useKeys, useNav } from '../nav'
import * as pages from '../pages'
import type { Card } from '../pages'
import { CardRows, useCardRows, type RowOf } from '../ui/CardRows'
import Icon from '../ui/Icon'
import { notify } from '../ui/Notice'
import Rail, { homePage, type Entry } from '../ui/Rail'
import Sheet, { type Choice } from '../ui/Sheet'
import LiveTv from './LiveTv'
import Profiles from './Profiles'
import Settings from './Settings'
import Title from './Title'
import '../home/Home.css'
import '../screens/Title.css'
import './Search.css'
import * as keyboard from '../keyboard'
import PosterImg from '../ui/PosterImg'

// Search: results as you type (300 ms after you
// stop), Smart Search (the AI, when the household has it) for moods, plots, actors and roles, recent searches and ideas when
// the box is empty, and the details box and backdrop following focus.

const IDEAS = [
  'Something funny and light for a tired evening',
  'A thriller where the villain wins in the end',
  'A small town hiding a dark secret',
  'A slow-burn series with a mind-blowing ending',
]
const QUICK_AFTER_MS = 300

type Quick = { titles: Card[]; people: Card[] }
type Ai = { q: string; state: 'thinking' | 'done' | 'none' | 'failed'; items: Card[] }
type Menu = { title: string; subtitle?: string; choices: Choice[] }

/** Lower case, letters and digits of any script (Hindi too), single spaces. */
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').replace(/ +/g, ' ').trim()

/** Whether [q] (typed) is (part of) one of the top titles' names, i.e. a plain title search: typed
 * words are the start of the title's ("interst" is Interstellar); a title's are whole words in what's
 * typed ("It" isn't in "a heist with a twist"). */
function titleMatchOf(q: string, titles: Card[]) {
  const n = norm(q)
  if (!n) return false
  return titles.slice(0, 3).some(t => { const m = norm(t.name); return !!m && (` ${m}`.indexOf(` ${n}`) >= 0 || ` ${n} `.indexOf(` ${m} `) >= 0) })
}

export default function Search() {
  const nav = useNav()
  const front = useIsFront()
  const root = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLInputElement>(null)
  const pill = useRef<HTMLButtonElement>(null)
  const [text, setText] = useState('')
  const [quick, setQuick] = useState<Quick | null>(null)
  // What's typed that results are on their way for, or that couldn't be searched.
  const [look, setLook] = useState<{ q: string; state: 'searching' | 'failed' } | null>(null)
  // What's typed the results shown are for.
  const [answered, setAnswered] = useState('')
  const [ai, setAi] = useState<Ai | null>(null)
  const [recent, setRecent] = useState<string[]>([])
  // Whether the household has the AI (it's optional): without it, no Smart Search button, ideas or row,
  // and OK in the box goes to the titles. A server that doesn't say is taken to have it.
  const [hasAi, setHasAi] = useState(true)
  const hasAiRef = useRef(hasAi)
  hasAiRef.current = hasAi
  const [inResults, setInResults] = useState(false)
  const [rail, setRail] = useState(false)
  const [menu, setMenu] = useState<Menu | null>(null)
  const q = text.trim()

  // Recent searches, this profile's, from the server.
  useEffect(() => {
    api.call<{ recent?: string[]; aiAvailable?: boolean }>('/launcher/recent.json').then(r => { setRecent(r.recent ?? []); setHasAi(r.aiAvailable !== false) }, () => {})
    focusEl(box.current)
  }, [])
  const remember = (s: string) => {
    const t = s.trim()
    if (t.length < 2) return
    setRecent(r => [t, ...r.filter(x => x.toLowerCase() !== t.toLowerCase())].slice(0, 8))
    api.send('/launcher/recent', { q: t })
  }

  // As you type: 300 ms after the last key; answers for older text are dropped.
  const asked = useRef('')
  const quickFor = (s: string) => {
    asked.current = s
    setLook({ q: s, state: 'searching' })
    pages.get<Quick>(`/launcher/search/quick.json?q=${encodeURIComponent(s)}`).then(r => {
      if (asked.current !== s) return
      const found = { titles: r.titles ?? [], people: r.people ?? [] }
      setQuick(found)
      setAnswered(s)
      setLook(null)
      if (enterPending.current === s) { enterPending.current = null; enter(s, found) }
    }, () => {
      if (asked.current !== s) return
      setLook({ q: s, state: 'failed' })
      // (The last query's results aren't left up as if they were this one's.)
      setQuick(null)
      setAnswered('')
      if (enterPending.current === s) enterPending.current = null
    })
  }
  useEffect(() => {
    // (Typed on: an Enter waiting for the last text's results is dropped.)
    if (enterPending.current !== q) enterPending.current = null
    if (q.length < 2) { asked.current = ''; setQuick(null); setLook(null); return }
    // (Already asked for this text: a recent search picked asks at once.)
    if (asked.current === q) return
    // (Enter may have asked for it already meanwhile: not twice.)
    const t = setTimeout(() => { if (asked.current !== q) quickFor(q) }, QUICK_AFTER_MS)
    return () => clearTimeout(t)
  }, [q])

  const titleMatch = () => titleMatchOf(q, quick?.titles ?? [])

  /** Enter (or a recent search picked): a known title ("harry potter") jumps to the results; a
   * description asks the AI. Decided on this query's own results: asked now if they aren't in. */
  const enterPending = useRef<string | null>(null)
  const enter = (s: string, found: Quick | null) => {
    if (s.length < 2) return
    if (!found) {
      enterPending.current = s
      if (!(asked.current === s && look?.q === s && look.state === 'searching')) quickFor(s)
      return
    }
    if (!hasAiRef.current || titleMatchOf(s, found.titles)) {
      remember(s)
      if (found.titles.length || found.people.length) r_.focusCard(0, 0)
    } else smart(s)
  }

  // Smart Search.
  const aiAsked = useRef('')
  const latestQ = useRef(q)
  latestQ.current = q
  const smart = (query = q) => {
    const s = query.trim()
    if (s.length < 2 || (ai?.q === s && ai.state === 'thinking')) return
    remember(s)
    aiAsked.current = s
    setAi({ q: s, state: 'thinking', items: [] })
    const path = `/launcher/search/ai.json?q=${encodeURIComponent(s)}`
    pages.get<{ items?: Card[]; note?: string }>(path, false, api.TIMEOUT.slow).then(r => {
      if (aiAsked.current !== s) return
      // The AI can't be used now (its monthly limit, no key): Smart Search goes away, the title results
      // stay; this answer isn't kept for when it's back.
      if (r.note) {
        pages.forget(path)
        setHasAi(false)
        setAi(null)
        return
      }
      const items = r.items ?? []
      setAi(a => (a?.q !== s ? a : { q: s, state: items.length ? 'done' : 'none', items }))
      // (Only if they're still waiting on it, not typing something else or browsing.)
      const active = document.activeElement
      if (items.length && latestQ.current === s && (active === box.current || active === pill.current)) setTimeout(() => r_.focusCard(0, 0), 0)
    }, () => setAi(a => (a?.q !== s ? a : { q: s, state: 'failed', items: [] })))
  }

  // The rows.
  const prompt: Card = { id: '__prompt', name: q }
  const aiNow = ai && ai.q === q ? ai : null
  const smartRow: RowOf<Card> | null = q.length < 2 || !hasAi ? null
    : aiNow?.state === 'done' ? { id: 'smart', title: '✦  Smart picks', kind: 'posters', items: aiNow.items }
    : {
        id: 'smart', kind: 'prompt', items: [prompt],
        title: aiNow?.state === 'thinking' ? '✦  Smart Search is thinking…'
          : aiNow?.state === 'none' ? '✦  Smart Search found nothing — try describing it differently'
          : aiNow?.state === 'failed' ? "✦  Smart Search isn't available right now — press OK to try again"
          : '✦  Smart Search',
      }
  const titlesRow: RowOf<Card> | null = quick?.titles.length ? { id: 'titles', title: 'Titles', kind: 'posters', items: quick.titles } : null
  const peopleRow: RowOf<Card> | null = quick?.people.length ? { id: 'people', title: 'People', kind: 'cast', items: quick.people } : null
  const smartFirst = hasAi && (!!aiNow || (q.length >= 2 && !titleMatch()))
  const rows = (smartFirst ? [smartRow, titlesRow, peopleRow] : [titlesRow, smartRow, peopleRow]).filter((x): x is RowOf<Card> => !!x && x.items.length > 0)

  const isTitle = (row?: RowOf<Card>, c?: Card) => !!row && !!c && (row.id === 'titles' || row.id === 'smart') && row.kind === 'posters' && (c.type === 'movie' || c.type === 'series')

  const open = (rowIndex: number, i: number) => {
    const row = rows[rowIndex], c = row?.items[i]
    if (!row || !c) return
    if (row.kind === 'prompt') return smart(c.name)
    remember(q)
    if (row.kind === 'cast') return nav.push(<Title kind="person" id={c.id} name={c.name} />)
    // (A report: no page changes because of it.)
    api.send('/launcher/interaction', { id: c.id, kind: 'searched_opened', origin: 'search' })
    nav.push(<Title kind={(c.type ?? 'movie') as pages.Kind} id={c.id} name={c.name} source={{ origin: 'search' }} />)
  }

  // Long OK on a title: it stays in the results (Not interested takes it out).
  const menuFor = (rowIndex: number, i: number): Menu | null => {
    const row = rows[rowIndex], c = row?.items[i]
    if (!isTitle(row, c) || !c) return null
    const say = (job: Promise<unknown>, done: string, drop = false) => job.then(() => {
      notify(done)
      // ("You won't see it again": it goes from the results too.)
      if (!drop) return
      setQuick(x => x && { ...x, titles: x.titles.filter(t => t.id !== c.id) })
      setAi(a => a && { ...a, items: a.items.filter(t => t.id !== c.id) })
    }, () => notify("Couldn't save that. Try again."))
    return {
      title: c.name, subtitle: [c.type === 'series' ? 'Series' : 'Film', c.year].filter(Boolean).join('  ·  '),
      choices: [
        { icon: 'act_watched', label: 'Mark as watched', run: () => say(api.post('/launcher/watched', { type: c.type, id: c.id, watched: true }), `${c.name} marked as watched`) },
        { icon: 'act_not_interested', label: 'Not interested', run: () => say(api.post('/launcher/hide', { id: c.id, kind: 'notInterested', hidden: true }), `You won't see ${c.name} again`, true) },
        // (Always Add: results are the same for everyone, so they can't say it's on the list.)
        { icon: 'add', label: 'Add to My List', run: () => say(api.post('/launcher/mylist', { id: c.id, type: c.type, on: true }), `${c.name} added to My List`) },
      ],
    }
  }

  const r_ = useCardRows({
    root, rows, front: front && !menu && !rail,
    onOpen: open, hasMenu: (rr, i) => !!menuFor(rr, i), onMenu: (rr, i) => setMenu(menuFor(rr, i)), onLeftEdge: () => setRail(true),
  })

  // Keys.
  useKeys((key, e) => {
    if (rail || menu) return
    const active = document.activeElement
    // Nothing focused here counts as the box: Back that only closed the TV's keyboard (webOS)
    // takes focus off it, and Down must still reach the results.
    const lost = !active || active === document.body || !root.current?.contains(active)
    if (active === box.current || (lost && key !== 'ok')) {
      if (key === 'ok') {
        // (The keyboard closed: OK opens it again.)
        if (!keyboard.typing(box.current)) return
        e.preventDefault()
        enter(q, answered === q ? quick : null)
        return true
      }
      if (key === 'down') {
        if (rows.length) r_.focusCard(0, Math.min(r_.focus.at[rows[0].id] ?? 0, rows[0].items.length - 1))
        else focusEl(root.current?.querySelector<HTMLElement>('.search-empty .search-chip'))
        return true
      }
      if (key === 'right' && hasAi && box.current && box.current.selectionStart === box.current.value.length && q.length >= 2) { focusEl(pill.current); return true }
      if (key === 'up') { if (lost) focusEl(box.current); return true }
      return
    }
    if (active === pill.current) {
      if (key === 'left') { focusEl(box.current); return true }
      if (key === 'down') { if (rows.length) r_.focusCard(0, 0); return true }
      if (key === 'up' || key === 'right') return true
      return
    }
    const onCard = (active as HTMLElement | null)?.dataset?.row
    if (onCard != null && key === 'up' && Number(onCard) === 0) { focusEl(box.current); return true }
    // Back in the results goes to the search box first; Back again leaves.
    if (onCard != null && key === 'back') { focusEl(box.current); return true }
    if (onCard == null && active?.closest('.search-empty')) {
      if (key === 'up' && active.closest('.chips-first')) { focusEl(box.current); return true }
      return
    }
    return r_.onKey(key, e)
  })

  const pickRail = (entry: Entry) => {
    setRail(false)
    if (entry === 'search') return setTimeout(() => focusEl(box.current), 0)
    const page = homePage(entry)
    if (page) return nav.popToRoot(page)
    if (entry === 'profile') return nav.push(<Profiles fromMenu />)
    nav.push(entry === 'live' ? <LiveTv /> : <Settings />)
  }

  const chip = (s: string, run: () => void, n: number) => (
    <button key={`${n}:${s}`} className="search-chip" data-f="" onClick={run}>{s}</button>
  )

  // The details box.
  const row = rows[r_.focus.row]
  const card = row?.items[Math.min(r_.focus.at[row.id] ?? 0, row.items.length - 1)]
  const typing = !inResults
  let details: { eyebrow: string; title: string; meta: string; reason: string; waiting?: boolean } | null = null
  let backdrop: string | undefined
  if (q.length >= 2) {
    if (typing) {
      const top = quick?.titles[0]
      details = top
        ? { eyebrow: 'Titles', title: top.name, meta: [top.type === 'series' ? 'Series' : 'Film', top.year, top.rating ? `★ ${Number(top.rating).toFixed(1)}` : ''].filter(Boolean).join('  ·  '), reason: top.overview ?? '' }
        // While results are on their way, say so (gently breathing); if they couldn't come, say that.
        : { eyebrow: 'Search', title: q, reason: hasAi ? 'Press ✦ Smart Search to find titles that match this description.' : '',
            meta: look?.q === q ? (look.state === 'searching' ? 'Searching…' : "Couldn't search right now. Check the connection and try again.")
              : quick && answered === q ? 'No titles found' : '',
            waiting: look?.q === q && look.state === 'searching' }
      backdrop = top?.backdrop
    } else if (row && card) {
      if (row.kind === 'prompt') details = { eyebrow: '✦  Smart Search', title: q, meta: 'Understands moods, plots, actors and roles', reason: 'Press OK to find titles that fit this description.' }
      else if (row.kind === 'cast') details = { eyebrow: 'People', title: card.name, meta: card.character ? `Known for ${card.character}` : '', reason: 'Press OK to see their films and series' }
      else {
        details = {
          eyebrow: row.id === 'smart' ? '✦  Smart pick' : 'Titles', title: card.name,
          meta: [card.type === 'series' ? 'Series' : 'Film', card.year, card.rating ? `★ ${Number(card.rating).toFixed(1)}` : ''].filter(Boolean).join('  ·  '),
          reason: card.reason ? `✦ ${card.reason}` : card.overview ?? '',
        }
        backdrop = card.backdrop
      }
    }
  } else if (!typing && row && card && row.kind === 'posters') {
    backdrop = card.backdrop
  }
  const showEmpty = q.length < 2 && !inResults

  return (
    <div ref={root} className="home search" onFocus={e => setInResults(!!(e.target as HTMLElement).dataset?.row)}>
      <div className="backdrop" aria-hidden>
        {backdrop && <img key={backdrop} className="backdrop-img" src={backdrop} alt="" />}
        <span className="scrim-left" />
        <span className="scrim-bottom" />
      </div>
      <div className={`dims${rail ? ' dim' : ''}`} data-inert={rail || menu ? '' : undefined}>
        <div className="search-bar">
          <Icon name="nav_search" size={20} />
          <input ref={box} className="search-box" data-f="" value={text} placeholder="Search films, series and people"
            spellCheck={false} autoComplete="off" autoCorrect="off" onChange={e => setText(e.target.value)} />
          <button ref={pill} className={`search-pill${ai?.state === 'thinking' ? ' busy' : ''}`} data-f={hasAi ? '' : undefined}
            style={{ visibility: q.length >= 2 && hasAi ? 'visible' : 'hidden' }} onClick={() => smart()}>
            {ai?.state === 'thinking' && ai.q === q ? '✦  Searching…' : '✦  Smart Search'}
          </button>
        </div>
        {showEmpty ? (
          <div className="search-empty">
            {recent.length > 0 && <>
              <span className="search-label">Recent searches</span>
              {/* (Three fit the row, a Smart Search phrase included. Picked again, it's as if typed and
                  Enter pressed: a description goes to Smart Search again.) */}
              <div className="chips chips-first">{recent.slice(0, 3).map((s, n) => chip(s, () => { setText(s); focusEl(box.current); enter(s, null) }, n))}</div>
            </>}
            {hasAi && <>
              <span className="search-label">Try a Smart Search</span>
              <div className={`chips ideas${recent.length ? '' : ' chips-first'}`}>
                {IDEAS.map((s, n) => chip(`✦  ${s}`, () => { setText(s); smart(s) }, n))}
              </div>
            </>}
          </div>
        ) : details && (
          <div key={`${details.eyebrow}:${details.title}`} className="search-details">
            <span className="hero-eyebrow">{details.eyebrow}</span>
            <h1 className="search-title">{details.title}</h1>
            {details.meta && <span className={`hero-meta${details.waiting ? ' waiting' : ''}`}>{details.meta}</span>}
            {details.reason && <span className="search-reason">{details.reason}</span>}
          </div>
        )}
        {rows.length > 0 && (
          <CardRows className="search-rows" rows={rows} focus={r_.focus} onFocusCard={r_.onFocusCard}
            onPick={(rr, i) => { if (!menuFor(rr, i)) open(rr, i) }}
            card={(rw, c, _i, load) => rw.kind === 'prompt' ? (
              <span className="prompt">
                <span className="prompt-eyebrow">✦  Smart Search</span>
                <span className="prompt-q">“{c.name}”</span>
                <span className="prompt-hint">Finds titles by mood, plot, actor or role</span>
              </span>
            ) : rw.kind === 'cast' ? (
              <span className="cast">
                <span className="cast-photo">{load && c.photo && <img src={c.photo} alt="" />}</span>
                <span className="cast-name">{c.name}</span>
                <span className="cast-character">{c.character}</span>
              </span>
            ) : (
              <span className="poster page-poster">{load && <PosterImg src={c.poster} name={c.name} />}<span className="sheen" /></span>
            )} />
        )}
      </div>
      <Rail open={rail} page="search" onClose={() => setRail(false)} onPick={pickRail} />
      {menu && <Sheet title={menu.title} subtitle={menu.subtitle} choices={menu.choices} onClose={() => setMenu(null)} />}
    </div>
  )
}
