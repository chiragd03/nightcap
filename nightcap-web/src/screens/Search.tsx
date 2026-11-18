import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import * as api from '../api'
import Menu, { type Action } from '../components/Menu'
import PlayOnTv from '../components/PlayOnTv'
import { useNotice } from '../components/Notice'
import PosterCard from '../components/PosterCard'
import Shelf from '../components/Shelf'
import type { Card } from '../types'
import './TitlePage.css'
import './Search.css'
import Img from '../components/Img'
import { wide } from '../images'
import { RowSkeleton } from '../components/RowView'

// Search, after the TV's: a wide bar with Smart Search inside it (when the household
// has the AI: it's optional, and without it Search is titles and people by name); with nothing
// typed, recent searches and Smart Search ideas; while typing, titles and people from TMDB a
// moment after you stop, and Smart Search (the AI reading a description) one press away. A search
// that isn't a title's name leads with Smart Search. The picture and details on top follow the
// result under the pointer. What's typed is in the address (?q=), so Back returns to it.

const TYPING_PAUSE_MS = 300
const SUGGESTIONS = [
  'Something funny and light for a tired evening',
  'A thriller where the villain wins in the end',
  'A small town hiding a dark secret',
  'A slow-burn series with a mind-blowing ending',
]

type Smart = { q: string; state: 'thinking' | 'done' | 'failed'; items: Card[] }
type Peek = { kind: 'title' | 'smart' | 'person' | 'ask'; card?: Card }

/** Lower case, letters and digits of any script (Hindi too), single spaces. */
const normalise = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').replace(/ +/g, ' ').trim()

/** A title search: what's typed is (part of) one of the top titles' names. Typed words are the start
 * of the title's ("interst" is Interstellar); a title's are whole words in what's typed ("It" isn't
 * in "a heist with a twist"). */
function titleMatchOf(q: string, titles: Card[]) {
  const m = normalise(q)
  if (!m) return false
  return titles.slice(0, 3).some(t => { const n = normalise(t.name); return !!n && (` ${n}`.includes(` ${m}`) || ` ${m} `.includes(` ${n} `)) })
}

// The last answers, by text, for this visit: Back to a search shows its results at once (and where
// they were scrolled to), while they're asked for again.
const answered = new Map<string, api.QuickResults>()

export default function Search() {
  // (A phone's bar has room for fewer words beside Smart Search.)
  const narrow = typeof matchMedia === 'function' && matchMedia('(max-width: 700px)').matches
  const [params, setParams] = useSearchParams()
  const [typed, setTyped] = useState(params.get('q') ?? '')
  const q = typed.trim()
  const [quick, setQuick] = useState<{ q: string; results: api.QuickResults } | undefined>(() => {
    const kept = answered.get(`${api.profile.get()}:${q}`)
    return kept && { q, results: kept }
  })
  // (The text whose titles couldn't be had: said, with Try again.)
  const [quickFailed, setQuickFailed] = useState<string>()
  const [smart, setSmart] = useState<Smart>()
  const [recent, setRecent] = useState<string[]>([])
  const [peek, setPeek] = useState<Peek>()
  const [menu, setMenu] = useState<{ title: string; subtitle?: string; actions: Action[] }>()
  const [notice, notify] = useNotice()
  const [onTv, setOnTv] = useState<Card>()
  const bar = useRef<HTMLInputElement>(null)

  // Whether the household has the AI: without it, no Smart Search button, ideas or row, and Enter just
  // searches titles (until the answer comes, it's taken to have it).
  const [ai, setAi] = useState(true)
  const aiRef = useRef(ai)
  aiRef.current = ai
  useEffect(() => { api.searchStart().then(r => { setRecent(r.recent); setAi(r.ai) }, () => {}) }, [])

  // As you type: the address follows (replacing, not adding to history), and TMDB is asked a
  // moment after you stop. An answer for older typing is dropped.
  const latest = useRef(q)
  latest.current = q
  // The text last asked about, and Enter pressed before its results came.
  const asked = useRef('')
  const enterPending = useRef<string | null>(null)
  const quickFor = (text: string) => {
    asked.current = text
    setQuickFailed(undefined)
    api.quickSearch(text).then(results => {
      answered.set(`${api.profile.get()}:${text}`, results)
      if (answered.size > 20) answered.delete(answered.keys().next().value!)
      if (text !== latest.current) return
      setQuick({ q: text, results })
      if (enterPending.current === text) { enterPending.current = null; decide(text, results) }
    }, () => {
      // (Not answered: Enter asks again.)
      if (asked.current === text) asked.current = ''
      if (text === latest.current) setQuickFailed(text)
      // (Web: Enter waiting on titles that couldn't be had still asks Smart Search, which may answer.)
      if (enterPending.current === text) { enterPending.current = null; if (aiRef.current) askSmart(text) }
    })
  }
  useEffect(() => {
    // (Typed on: an Enter waiting for the last text's results is dropped.)
    if (enterPending.current !== q) enterPending.current = null
    if (q.length < 2) { asked.current = ''; setQuick(undefined); return }
    // (Already asked for this text: a recent search picked asks at once.)
    if (asked.current === q) return
    // (Enter may have asked for it already meanwhile: not twice.)
    const t = setTimeout(() => { if (asked.current !== q) quickFor(q) }, TYPING_PAUSE_MS)
    return () => clearTimeout(t)
  }, [q])
  // A Smart Search that ran for this text stays in the address (&smart=1), so Back brings its picks.
  const smartRan = smart?.q === q
  useEffect(() => {
    setParams(q ? { q, ...(smartRan ? { smart: '1' } : {}) } : {}, { replace: true })
  }, [q, smartRan])

  const remember = (text: string) => {
    if (text.length < 2) return
    setRecent(r => [text, ...r.filter(x => x.toLowerCase() !== text.toLowerCase())].slice(0, 8))
    api.rememberSearch(text).then(setRecent, () => {})
  }

  const askSmart = (text = q) => {
    if (!aiRef.current) { remember(text); bar.current?.blur(); return }
    if (text.length < 2 || (smart?.q === text && smart.state === 'thinking')) return
    if (text !== latest.current) setTyped(text)
    remember(text)
    bar.current?.blur()
    setSmart({ q: text, state: 'thinking', items: [] })
    api.smartSearch(text).then(r => {
      // The AI can't be used now (its monthly limit, no key): Smart Search goes away, the title
      // results stay.
      if (r.note) { setSmart(cur => (cur?.q === text ? undefined : cur)); setAi(false); return }
      setSmart(cur => (cur?.q === text ? { q: text, state: 'done', items: r.items } : cur))
    }, () => setSmart(cur => (cur?.q === text ? { q: text, state: 'failed', items: [] } : cur)))
  }

  /** Enter (or a recent search picked): a known title ("harry potter") just shows the results; a
   * description asks the AI. Decided on this text's own results: asked now if they aren't in. */
  const enter = (text = q) => {
    if (text.length < 2) return
    if (quick?.q === text) return decide(text, quick.results)
    enterPending.current = text
    if (asked.current !== text) quickFor(text)
  }
  const decide = (text: string, results: api.QuickResults) => {
    if (!aiRef.current || titleMatchOf(text, results.titles)) { remember(text); bar.current?.blur() }
    else askSmart(text)
  }

  const startedSmart = useRef(false)
  useEffect(() => {
    if (startedSmart.current) return
    startedSmart.current = true
    if (params.get('smart') === '1' && q.length >= 2) askSmart(q)
  }, [])
  // (Found out late that there's no AI: a Smart Search started from the address is dropped.)
  useEffect(() => { if (!ai) setSmart(undefined) }, [ai])

  const opened = (card: Card) => { remember(q); api.searchedOpened(card.id) }

  // The TV's long-press menu for a title: watched already, or not for you.
  const titleMenu = (card: Card) => (e: MouseEvent) => {
    e.preventDefault(); e.stopPropagation()
    if (card.type !== 'movie' && card.type !== 'series') return
    const act = (job: Promise<unknown>, done: string, drop = false) => job.then(() => {
      notify(done)
      // ("You won't see it again": it goes from the results too.)
      if (!drop) return
      setQuick(x => x && { ...x, results: { ...x.results, titles: x.results.titles.filter(t => t.id !== card.id) } })
      setSmart(x => x && { ...x, items: x.items.filter(t => t.id !== card.id) })
      setPeek(p => (p?.card?.id === card.id ? undefined : p))
    }, () => notify("Couldn't save that. Try again."))
    setMenu({
      title: card.name, subtitle: [card.type === 'series' ? 'Series' : 'Film', card.year].filter(Boolean).join('  ·  '),
      actions: [
        { icon: 'play', label: 'Play on TV', run: () => setOnTv(card) },
        { icon: 'act_watched', label: 'Mark as watched', run: () => act(api.markWatched(card.type!, card.id, true), `${card.name} marked as watched`) },
        { icon: 'act_not_interested', label: 'Not interested', run: () => act(api.notInterested(card.id, card.type!, card.name), `You won't see ${card.name} again`, true) },
        // (Always Add: results are the same for everyone, so they can't say it's on the list; adding twice is harmless.)
        { icon: 'add', label: 'Add to My List', run: () => act(api.setMyList(card.id, card.type as 'movie' | 'series', true), `${card.name} added to My List`) },
      ],
    })
  }

  // ---------- What shows ----------

  const searching = q.length >= 2
  // (While the answer for new typing comes, the last results stay, dimmed: nothing jumps.)
  const results = searching && quickFailed !== q ? quick?.results : undefined
  const waitingFor = searching && quick?.q !== q && quickFailed !== q
  const smartHere = smart?.q === q ? smart : undefined
  // A title search (what's typed is, or is in, a top title's name) puts Titles first.
  // (Only this text's own results decide: not the last ones, shown dimmed meanwhile.)
  const titleMatch = !!results && quick?.q === q && titleMatchOf(q, results.titles)
  const smartFirst = ai && (!!smartHere || !titleMatch)
  const top = peek ?? (smartHere?.items[0] ? { kind: 'smart' as const, card: smartHere.items[0] } : results?.titles[0] ? { kind: 'title' as const, card: results.titles[0] } : undefined)

  const titlesRow = results && results.titles.length > 0 && (
    <Shelf key="titles" title="Titles" scrollKey={results.titles.length}>
      {results.titles.map(c => <PosterCard key={c.id} card={c} onPeek={() => setPeek({ kind: 'title', card: c })} onMenu={titleMenu(c)} onOpen={() => opened(c)} />)}
    </Shelf>
  )
  const smartRow = searching && ai && (
    smartHere?.state === 'done' && smartHere.items.length > 0 ? (
      <Shelf key="smart" title={<><span className="spark">✦</span> Smart picks</>} scrollKey={smartHere.items.length}>
        {smartHere.items.map(c => <PosterCard key={c.id} card={c} onPeek={() => setPeek({ kind: 'smart', card: c })} onMenu={titleMenu(c)} onOpen={() => opened(c)} />)}
      </Shelf>
    ) : (
      <section key="ask" className="row">
        <div className="row-head"><h2 className="row-title"><span className="spark">✦</span> Smart Search</h2></div>
        <div className="ask-wrap">
          <button className={`ask-card${smartHere?.state === 'thinking' ? ' thinking' : ''}`} onClick={() => askSmart()}
            onMouseEnter={() => setPeek({ kind: 'ask' })} onFocus={() => setPeek({ kind: 'ask' })}>
            <span className="ask-q">“{q}”</span>
            <span className="ask-sub">
              {smartHere?.state === 'thinking' ? 'Thinking…'
                : smartHere?.state === 'failed' ? "Smart Search isn't available right now. Click to try again."
                : smartHere?.state === 'done' ? 'Nothing found. Try describing it differently.'
                : 'Find titles that fit this: moods, plots, actors and roles'}
            </span>
          </button>
        </div>
      </section>
    )
  )
  const peopleRow = results && results.people.length > 0 && (
    <Shelf key="people" title="People" className="cast" scrollKey={results.people.length}>
      {results.people.map(c => (
        <Link key={c.id} to={`/person/${c.id}`} className="card cast" onMouseEnter={() => setPeek({ kind: 'person', card: c })} onClick={() => remember(q)}>
          <span className="cast-photo"><Img src={c.photo} fallback={c.name[0]} /></span>
          <b>{c.name}</b>
          {c.character && <span className="card-sub">{c.character}</span>}
        </Link>
      ))}
    </Shelf>
  )

  return (
    <div className="search-page">
      {searching && <Details peek={top} q={q} ai={ai} />}

      <form className={`search-bar${searching ? ' up' : ''}`} onSubmit={e => { e.preventDefault(); enter() }} role="search">
        <svg className="search-icon" viewBox="0 0 256 256" aria-hidden><path fill="currentColor" d="M228.24,219.76l-51.38-51.38a86.15,86.15,0,1,0-8.48,8.48l51.38,51.38a6,6,0,0,0,8.48-8.48ZM38,112a74,74,0,1,1,74,74A74.09,74.09,0,0,1,38,112Z" /></svg>
        <input ref={bar} value={typed} onChange={e => { setTyped(e.target.value); setPeek(undefined) }} placeholder={narrow ? 'Films, series, people' : 'Search films, series and people'}
          aria-label="Search" autoFocus spellCheck={false} autoComplete="off" enterKeyHint="search" />
        {typed && <button type="button" className="search-clear" aria-label="Clear" onClick={() => { setTyped(''); bar.current?.focus() }}>×</button>}
        {ai && (
          <button type="button" className={`ask-pill${smartHere?.state === 'thinking' ? ' thinking' : ''}`} disabled={q.length < 2} onClick={() => askSmart()}>
            ✦ {smartHere?.state === 'thinking' ? 'Searching…' : 'Smart Search'}
          </button>
        )}
      </form>

      {!searching ? (
        <div className="search-ideas">
          {recent.length > 0 && (
            <>
              <h2 className="eyebrow">Recent searches</h2>
              <div className="chips">{recent.map(r => <button key={r} className="chip" onClick={() => { setTyped(r); enter(r) }}>{r}</button>)}</div>
            </>
          )}
          {ai && (
            <>
              <h2 className="eyebrow">Try a Smart Search</h2>
              <div className="chips">
                {SUGGESTIONS.map(s => <button key={s} className="chip idea" onClick={() => askSmart(s)}><span className="spark">✦</span> {s}</button>)}
              </div>
            </>
          )}
        </div>
      ) : (
        <div className={`search-rows${waitingFor && results ? ' waiting' : ''}`} onMouseLeave={() => setPeek(undefined)} aria-busy={waitingFor}>
          {quickFailed === q && (
            <div className="search-failed" role="alert">
              <p>Couldn't search right now. Check the connection and try again.</p>
              <button className="btn" onClick={() => quickFor(q)}>Try again</button>
            </div>
          )}
          {!results && waitingFor && <RowSkeleton title="Titles" />}
          {smartFirst ? [smartRow, titlesRow, peopleRow] : [titlesRow, smartRow, peopleRow]}
          {results && quick?.q === q && !results.titles.length && !results.people.length && !smartHere && (
            <p className="search-none">{ai ? 'Nothing by that name. Smart Search can find titles from a description.' : 'Nothing by that name.'}</p>
          )}
        </div>
      )}
      {menu && <Menu {...menu} onClose={() => setMenu(undefined)} />}
      {onTv && <PlayOnTv what={api.titleToPlay(onTv.type!, onTv.id)} name={onTv.name} onClose={() => setOnTv(undefined)} />}
      {notice}
    </div>
  )
}

/** The focused result's picture and details, as on the TV (eyebrow, title, facts, reason). */
function Details({ peek, q, ai }: { peek?: Peek; q: string; ai: boolean }) {
  const c = peek?.card
  let eyebrow = 'Search', name = q, meta = '', line = ai ? 'Press ✦ Smart Search to find titles that match this description.' : ''
  if (peek?.kind === 'ask') {
    eyebrow = '✦  Smart Search'; meta = 'Understands moods, plots, actors and roles'; line = 'Click to find titles that fit this description.'
  } else if (peek?.kind === 'person' && c) {
    eyebrow = 'People'; name = c.name; meta = c.character ?? ''; line = 'Open to see their films and series'
  } else if (c) {
    eyebrow = peek?.kind === 'smart' ? '✦  Smart pick' : 'Titles'
    name = c.name
    meta = [c.type === 'series' ? 'Series' : 'Film', c.year, c.rating ? `★ ${c.rating}` : null].filter(Boolean).join('  ·  ')
    line = c.reason ? `✦  ${c.reason}` : c.overview ?? ''
  }
  // (A picture that doesn't load leaves the top without one, not a broken image.)
  const [broken, setBroken] = useState<string>()
  const art = c?.backdrop && c.backdrop !== broken ? c.backdrop : undefined
  return (
    <section className="title-top search-top">
      {art && <div className="title-art"><img key={art} {...wide(art)} alt="" onError={() => setBroken(art)} /></div>}
      <div className="title-text">
        <div className="eyebrow title-eyebrow">{eyebrow}</div>
        <h1 className={name.length > 18 ? 'long' : ''}>{name}</h1>
        <div className="title-meta">{meta}</div>
        <p className="title-reason">{line}</p>
      </div>
    </section>
  )
}
