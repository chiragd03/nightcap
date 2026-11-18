import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import * as api from '../api'
import BackButton from '../components/BackButton'
import Icon from '../components/Icon'
import Menu, { type Action } from '../components/Menu'
import PlayOnTv from '../components/PlayOnTv'
import { useNotice } from '../components/Notice'
import PosterCard from '../components/PosterCard'
import Trailer from '../components/Trailer'
import Shelf, { scrollCardIntoView } from '../components/Shelf'
import type { Card, Header, Page, Section } from '../types'
import './TitlePage.css'
import { useLongPress } from '../components/longPress'
import Img from '../components/Img'
import { wide } from '../images'
import Problem from '../components/Problem'
import { RowSkeleton } from '../components/RowView'
import { errorWords, isOffline } from '../errors'

// A title's page, an actor's, or a Browse tile's (as on the TV): the picture and details on
// top, then seasons and episodes, cast and similar titles. The top follows the card under the
// pointer. Right-click (or a card's ⋯) opens the TV's long-press menu.

type Kind = 'title' | 'person' | 'browse'
const RATINGS = { [-1]: 'Not for me', 1: 'I like it', 2: 'Love it' } as const
const EYEBROW = { person: 'Cast', browse: 'Browse', series: 'Series', movie: 'Film' } as const

function load(kind: Kind, p: Record<string, string | undefined>) {
  if (kind === 'person') return api.personPage(p.id!)
  if (kind === 'browse') return api.browsePage(p.key!)
  return api.titlePage(p.type!, p.id!)
}

// The last pages opened, by profile and address, for this visit: Back to one shows it at once (and where it was
// scrolled to), while it's asked for again.
const opened = new Map<string, Page>()
const keepOpened = (key: string, p: Page) => {
  opened.delete(key)
  opened.set(key, p)
  if (opened.size > 20) opened.delete(opened.keys().next().value!)
}

export default function TitlePage({ kind }: { kind: Kind }) {
  const params = useParams()
  const navigate = useNavigate()
  const [page, setPage] = useState<Page | undefined>(() => opened.get(`${api.profile.get()}:${kind}${JSON.stringify(params)}`))
  // (A My List change on its way: the button waits, so two clicks can't race.)
  const [listSaving, setListSaving] = useState(false)
  const [error, setError] = useState<unknown>()
  const [similar, setSimilar] = useState<Card[]>([])
  const [peek, setPeek] = useState<{ section: Section; card: Card }>()
  const [menu, setMenu] = useState<{ title: string; subtitle?: string; actions: Action[] }>()
  const [rating, setRating] = useState(false)
  const [season, setSeason] = useState<string>()
  const [notice, notify] = useNotice()
  const [onTv, setOnTv] = useState<{ what: api.PlayWhat; name: string }>()
  const [trailer, setTrailer] = useState(false)
  const closeTrailer = useCallback(() => setTrailer(false), [])
  const key = JSON.stringify(params)
  // (Closed when the page becomes another title's: Back, or a similar title.)
  useEffect(() => setTrailer(false), [key])

  // (After any progress save still on its way, a player just closed: the page shows where it got to.)
  // (At most 3 s; and only the latest title's answer is shown, Back or a similar title meanwhile.)
  const shownKey = useRef(key)
  shownKey.current = key
  useEffect(() => setListSaving(false), [key])
  const reload = useCallback(() => {
    const mine = key
    return Promise.race([api.progressSaved(), new Promise(r => setTimeout(r, 3_000))]).then(() => load(kind, params))
      .then(p => { keepOpened(`${api.profile.get()}:${kind}${mine}`, p); if (shownKey.current === mine) { setPage(p); setError(undefined) } }, e => { if (shownKey.current === mine) setError(e) })
  }, [key])

  useEffect(() => {
    setPage(opened.get(`${api.profile.get()}:${kind}${key}`)); setError(undefined); setSimilar([]); setPeek(undefined); setSeason(undefined)
    // (Scrolling: components/Scroll, the top for a new page, where it was for Back.)
    reload()
    if (kind !== 'title') return
    // More like this: what's saved at once (TMDB's list until the AI's picks are worked out), then
    // the AI is asked for its picks (a few seconds), which replace it.
    let gone = false
    api.similar(params.type!, params.id!).then(r => {
      if (gone) return
      setSimilar(r.items)
      if (!r.ai) api.rankSimilar(params.type!, params.id!).then(ranked => { if (!gone && ranked.items.length) setSimilar(ranked.items) }, () => {})
    }, () => {})
    return () => { gone = true }
  }, [key])

  if (error && !page) return <Problem words={errorWords(error)} retry={() => { setError(undefined); reload() }} back autoRetry />
  if (!page) return <TitleSkeleton />

  const h = page.header
  const episodes = page.sections.filter(s => s.kind === 'episodes')
  const others = page.sections.filter(s => s.kind !== 'episodes')
  const series = h.type === 'series'
  const shownSeason = episodes.find(s => s.id === (season ?? page.focus?.section)) ?? episodes.find(s => s.id !== 's0') ?? episodes[0]

  // ---------- Actions ----------

  const act = async (job: Promise<unknown>, done: string) => {
    try {
      await job
      notify(done)
      reload()
    } catch (e) {
      notify(errorWords(e))
    }
  }

  // My List (as the Android TV's): shown at once, put back if it couldn't be saved; then the page is
  // asked for again, as after the other changes.
  const titleType = h.type === 'movie' || h.type === 'series' ? h.type : null
  const setInList = async (on: boolean) => {
    if (!titleType || listSaving) return
    setListSaving(true)
    const before = page, mine = key
    setPage(p => p && { ...p, header: { ...p.header, inList: on } })
    try {
      await api.setMyList(h.id, titleType, on)
      notify(on ? `${h.name} added to My List` : `${h.name} removed from My List`)
      reload()
    } catch {
      if (shownKey.current === mine) setPage(before)
      notify("Couldn't save that. Try again.")
    } finally {
      if (shownKey.current === mine) setListSaving(false)
    }
  }
  const listAction = (): Action => h.inList
    ? { icon: 'act_close', label: 'Remove from My List', run: () => setInList(false) }
    : { icon: 'add', label: 'Add to My List', run: () => setInList(true) }
  // A title shown on this page (not the page's own) put on My List: nothing on the page changes.
  const addToList = (card: Card) => api.setMyList(card.id, card.type as 'movie' | 'series', true)
    .then(() => notify(`${card.name} added to My List`), () => notify("Couldn't save that. Try again."))

  // A rating picked on the card; the one you'd given, picked again, clears it.
  const rate = (v: -1 | 1 | 2) => act(api.rate(h.id, h.myRating === v ? null : v), h.myRating === v ? 'Rating cleared' : RATINGS[v])

  const episodeMenu = (section: Section, card: Card) => {
    if (card.upcoming) return
    const what = series ? card.episode ?? 'Episode' : h.name
    const started = (card.progress ?? 0) > 0.01
    const actions: Action[] = [{ icon: 'play', label: 'Play on TV', run: () => setOnTv({
      what: { title: { type: h.type as 'movie' | 'series', id: card.id } }, name: series ? `${h.name}  ·  ${card.episode}` : h.name }) }]
    if (!card.watched) actions.push({ icon: 'act_watched', label: 'Mark as watched', run: () => act(api.markWatched(h.type, card.id, true), `${what} marked as watched`) })
    if (card.watched || started) actions.push({ icon: 'act_unwatched', label: 'Mark as unwatched', run: () => act(api.markWatched(h.type, card.id, false), `${what} marked as unwatched`) })
    if (series) {
      const n = Number(section.id.slice(1))
      const aired = section.items.filter(c => !c.upcoming)
      if (n > 0 && aired.some(c => !c.watched)) actions.push({ icon: 'act_watched', label: `Mark Season ${n} as watched`, run: () => act(api.markWatched('series', h.id, true, n), `Season ${n} marked as watched`) })
      if (n > 0 && aired.some(c => c.watched)) actions.push({ icon: 'act_unwatched', label: `Mark Season ${n} as unwatched`, run: () => act(api.markWatched('series', h.id, false, n), `Season ${n} marked as unwatched`) })
      if (episodes.some(s => s.id !== 's0' && s.items.some(c => !c.upcoming && !c.watched))) {
        actions.push({ icon: 'act_watched', label: 'Mark the whole show as watched', run: () => act(api.markWatched('series', h.id, true), `${h.name} marked as watched`) })
      }
    }
    if (titleType) actions.push(listAction())
    setMenu({ title: series ? card.name : h.name, subtitle: series ? card.episode : h.facts, actions })
  }

  const posterMenu = (card: Card) => {
    if (card.type !== 'movie' && card.type !== 'series') return
    setMenu({
      title: card.name, subtitle: [card.type === 'series' ? 'Series' : 'Film', card.year].filter(Boolean).join(' · '),
      actions: [
        { icon: 'play', label: 'Play on TV', run: () => setOnTv({ what: api.titleToPlay(card.type!, card.id), name: card.name }) },
        { icon: 'act_watched', label: 'Mark as watched', run: () => act(api.markWatched(card.type!, card.id, true), `${card.name} marked as watched`) },
        // (Gone from More like this too: the reload only brings the page's own rows.)
        { icon: 'act_not_interested', label: 'Not interested', run: () => act(api.notInterested(card.id, card.type!, card.name)
          .then(() => setSimilar(s => s.filter(x => x.id !== card.id))), `You won't see ${card.name} again`) },
        { icon: 'add', label: 'Add to My List', run: () => addToList(card) },
      ],
    })
  }

  const onMenu = (fn: () => void) => (e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); fn() }

  // ---------- What Play starts ----------

  const watchCard = episodes.find(s => s.id === 'watch')?.items[0]
  const current = series
    ? (page.focus && episodes.find(s => s.id === page.focus!.section)?.items[page.focus.index])
      ?? episodes.find(s => s.id !== 's0')?.items.find(c => !c.upcoming)
    : watchCard
  const playLabel = series
    ? current?.progress ? `Resume ${current.episode}` : current ? `Play ${current.episode}` : null
    : watchCard?.progress ? 'Resume' : h.watched ? 'Watch again' : 'Play'
  const playHref = current && !current.upcoming ? `/watch/${h.type}/${encodeURIComponent(current.id)}` : null
  // A film that isn't out yet: when it comes out, in Play's place; nothing to play, on the TV either.
  const notOut = h.type === 'movie' && !!watchCard?.upcoming

  return (
    <div className="title-page">
      {/* (A saved copy shown, and asking for it again failed: said.) */}
      {!!error && <div className="waking-line glass" role="status">{isOffline(error) ? "Can't reach Nightcap right now. Showing what was here." : "Couldn't refresh this page. Showing what was here."}</div>}
      <Top header={h} peek={peek}>
        <div className="title-actions">
          {(h.type === 'movie' || h.type === 'series') && (
            <>
              {playHref && playLabel && <Link className="btn primary" to={playHref} state={{ art: h.backdrop }}><Icon name="play" size={18} /> {playLabel}</Link>}
              {notOut && <span className="title-soon">{watchCard?.aired ? `Comes out ${niceDate(watchCard.aired)}` : 'Not out yet'}</span>}
              {h.trailer && <button className="btn" onClick={() => setTrailer(true)}>Trailer</button>}
              {!notOut && <button className="btn" onClick={() => setOnTv({
                what: api.titleToPlay(h.type as 'movie' | 'series', h.id, series ? current?.id : undefined),
                name: [h.name, series ? current?.episode : null].filter(Boolean).join('  ·  '),
              })}>Play on TV</button>}
              {h.type === 'movie' && !notOut && (
                <button className={`btn icon${h.watched ? ' on' : ''}`} title={h.watched ? 'Mark as unwatched' : 'Mark as watched'}
                  onClick={() => act(api.markWatched('movie', h.id, !h.watched), h.watched ? `${h.name} marked as unwatched` : `${h.name} marked as watched`)}>
                  <Icon name={h.watched ? 'act_watched' : 'check'} size={20} />
                </button>
              )}
              <button className={`btn icon rate-btn${h.myRating ? ' on' : ''}`} title={h.myRating ? `Your rating: ${RATINGS[h.myRating]}` : 'Rate'}
                onClick={() => setRating(true)}>
                <Icon name={h.myRating === -1 ? 'rate_down' : h.myRating === 2 ? 'rate_love' : 'rate_up'} size={20} />
              </button>
              {/* (The web's title actions are buttons; on the TVs, My List is in the hold-OK menu.) */}
              <button className={`btn icon${h.inList ? ' on' : ''}`} title={h.inList ? 'Remove from My List' : 'Add to My List'}
                aria-label="My List" aria-pressed={!!h.inList} disabled={listSaving} onClick={() => setInList(!h.inList)}>
                <Icon name={h.inList ? 'act_close' : 'add'} size={20} />
              </button>
              {series && (
                <button className={`btn icon bell-btn${h.notify ? ' on' : ''}`} title={h.notify ? 'New-episode alerts on' : 'New-episode alerts off'}
                  onClick={() => act(api.setNotify(h.id, !h.notify), h.notify ? `No more new-episode alerts for ${h.name}` : `You'll hear about new episodes of ${h.name}`)}>
                  <Icon name={h.notify ? 'act_bell' : 'act_bell_off'} size={20} />
                </button>
              )}
            </>
          )}
        </div>
      </Top>

      <div className="title-rows" onMouseLeave={() => setPeek(undefined)}>
        {series && shownSeason && (
          <Seasons
            seasons={episodes} shown={shownSeason} focus={page.focus} onPick={setSeason} backdrop={h.backdrop}
            onPeek={card => setPeek({ section: shownSeason, card })}
            onMenu={card => episodeMenu(shownSeason, card)}
            onPlay={card => navigate(`/watch/series/${encodeURIComponent(card.id)}`, { state: { art: card.thumbnail ?? h.backdrop, fallback: h.backdrop } })}
          />
        )}
        {others.map(sec => (
          <Shelf key={sec.id} title={sec.title} className={sec.kind} scrollKey={sec.items.length}>
            {sec.items.map(card => sec.kind === 'cast' ? (
              <Link key={card.id} to={`/person/${card.id}`} className="card cast" onMouseEnter={() => setPeek({ section: sec, card })}>
                <span className="cast-photo"><Img src={card.photo} fallback={card.name[0]} /></span>
                <b>{card.name}</b>
                {card.character && <span className="card-sub">{card.character}</span>}
              </Link>
            ) : (
              <PosterCard key={card.id} card={card} onPeek={() => setPeek({ section: sec, card })} onMenu={onMenu(() => posterMenu(card))} />
            ))}
          </Shelf>
        ))}
        {similar.length > 0 && (
          <Shelf title="More like this" scrollKey={similar.length}>
            {similar.map(card => {
              const sec: Section = { id: 'similar', title: 'More like this', kind: 'posters', items: similar }
              return <PosterCard key={card.id} card={card} onPeek={() => setPeek({ section: sec, card })} onMenu={onMenu(() => posterMenu(card))} />
            })}
          </Shelf>
        )}
      </div>
      {menu && <Menu {...menu} onClose={() => setMenu(undefined)} />}
      {rating && <RatingCard title={h.name} mine={h.myRating ?? null} onPick={v => { setRating(false); rate(v) }} onClose={() => setRating(false)} />}
      {onTv && <PlayOnTv {...onTv} onClose={() => setOnTv(undefined)} />}
      {trailer && h.trailer && <Trailer id={h.trailer} name={h.name} onClose={closeTrailer} />}
      {notice}
    </div>
  )
}

// ---------- The top: the title's picture and details, or the card under the pointer ----------

function Top({ header: h, peek, children }: { header: Header; peek?: { section: Section; card: Card }; children?: ReactNode }) {
  let eyebrow: string = EYEBROW[h.type]
  let name = h.name
  let meta: (string | null | undefined)[] = [h.facts, h.rating ? `★ ${h.rating}` : null]
  let reason: string | undefined
  let overview = h.overview
  let backdrop = h.backdrop

  if (peek) {
    const { section: s, card: c } = peek
    if (s.kind === 'episodes') {
      eyebrow = h.type === 'series' ? `${h.name}  ·  ${s.title}` : h.name
      if (h.type === 'series') name = c.name
      meta = [c.episode, c.upcoming ? (c.aired ? `Airs ${niceDate(c.aired)}` : 'Coming soon') : niceDate(c.aired), c.rating ? `★ ${c.rating}` : null]
      overview = c.overview ?? overview
    } else if (s.kind === 'cast') {
      eyebrow = 'Cast'
      name = c.name
      meta = [c.character ? `as ${c.character}` : null]
      reason = 'Open to see their films and series'
      overview = ''
    } else {
      eyebrow = h.type === 'person' || h.type === 'browse' ? `${h.name}  ·  ${s.title}` : s.title
      name = c.name
      meta = [c.type === 'series' ? 'Series' : 'Film', c.year, c.rating ? `★ ${c.rating}` : null]
      reason = c.reason ? (h.type === 'person' ? c.reason : `✦  ${c.reason}`) : undefined
      overview = c.overview ?? ''
      // A Browse page has no picture of its own: it follows the card.
      if (h.type === 'browse' && c.backdrop) backdrop = c.backdrop
    }
  }

  return (
    <section className={`title-top${h.type === 'person' ? ' person' : ''}`}>
      {backdrop && <div className="title-art"><Img key={backdrop} {...wide(backdrop)} main /></div>}
      <BackButton className="title-back" />
      <div className="title-text">
        <div className="eyebrow title-eyebrow">{eyebrow}</div>
        <h1 className={name.length > 18 ? 'long' : ''}>{name}</h1>
        <div className="title-meta">{meta.filter(Boolean).join('  ·  ')}</div>
        {reason && <p className="title-reason">{reason}</p>}
        {overview && <p className="title-overview">{overview}</p>}
        {children}
      </div>
    </section>
  )
}

// ---------- Seasons: a picker over one row of episodes ----------

type SeasonsProps = {
  seasons: Section[]
  shown: Section
  focus: Page['focus']
  onPick: (id: string) => void
  onPeek: (card: Card) => void
  onMenu: (card: Card) => void
  onPlay: (card: Card) => void
  /** The show's backdrop: an episode's picture when its own doesn't load. */
  backdrop?: string | null
}

function Seasons({ seasons, shown, focus, onPick, onPeek, onMenu, onPlay, backdrop }: SeasonsProps) {
  const row = useRef<HTMLDivElement>(null)
  const picker = useRef<HTMLDivElement>(null)
  const [scrolls, setScrolls] = useState(false)
  // Open on the episode you're on, with the chosen season in view in the picker.
  useEffect(() => {
    if (focus?.section === shown.id) scrollCardIntoView(row.current, focus.index)
    const p = picker.current
    p?.querySelector<HTMLElement>('.on')?.scrollIntoView({ block: 'nearest', inline: 'center' })
    setScrolls(!!p && p.scrollWidth > p.clientWidth)
  }, [shown.id])

  const tabs = seasons.length > 1 && (
    <div className={`seasons${scrolls ? ' scrolls' : ''}`} role="tablist" ref={picker}>
      {seasons.map(s => (
        <button key={s.id} role="tab" aria-selected={s.id === shown.id} className={s.id === shown.id ? 'on' : ''} onClick={() => onPick(s.id)}>
          {s.id === 's0' ? 'Specials' : s.id.slice(1)}
        </button>
      ))}
    </div>
  )

  return (
    <div ref={row} className="episodes-row">
      <Shelf title={shown.title} extra={tabs} className="episodes" scrollKey={shown.id}>
        {shown.items.map(card => (
          <HoldButton
            key={card.id}
            menu={card.upcoming ? undefined : () => onMenu(card)}
            className={`card episode${card.upcoming ? ' upcoming' : ''}`}
            onMouseEnter={() => onPeek(card)}
            onFocus={() => onPeek(card)}
            onClick={() => !card.upcoming && onPlay(card)}
            onContextMenu={e => { e.preventDefault(); onMenu(card) }}
          >
            <div className="still">
              <Still src={card.thumbnail} fallback={backdrop} />
              <span className="still-name">{card.episode?.split(' ').pop()}  ·  {card.name}</span>
              {card.watched && <span className="chip-watched"><Icon name="check" size={12} /> Watched</span>}
              {card.upcoming && <span className="chip-watched">{card.aired ? `Airs ${niceDate(card.aired)}` : 'Coming soon'}</span>}
              {card.progress ? <span className="still-progress"><span style={{ width: `${card.progress * 100}%` }} /></span> : null}
              {!card.upcoming && (
                <span className="card-more" role="button" aria-label="More" onClick={e => { e.stopPropagation(); onMenu(card) }}>⋯</span>
              )}
            </div>
          </HoldButton>
        ))}
      </Shelf>
    </div>
  )
}

/** An episode's picture. Many episodes have none (the guessed address answers 404, for a daily show
 * or one not out yet): the show's backdrop, faded, stands in, never a broken image. */
/** An episode's still, else the show's backdrop when it doesn't load; and when that doesn't either
 * (some shows have neither), nothing: a plain card, not a broken picture. */
function Still({ src, fallback }: { src?: string | null; fallback?: string | null }) {
  const [failed, setFailed] = useState(false)
  const [fallbackFailed, setFallbackFailed] = useState(false)
  useEffect(() => { setFailed(false); setFallbackFailed(false) }, [src, fallback])
  const shown = !src || failed ? (fallbackFailed ? null : fallback) : src
  if (!shown) return null
  return <img key={shown} src={shown} alt="" loading="lazy" className={shown === src ? undefined : 'stand-in'}
    onError={() => (shown === src ? setFailed(true) : setFallbackFailed(true))} />
}

function niceDate(iso?: string) {
  if (!iso) return undefined
  const d = new Date(`${iso.slice(0, 10)}T12:00:00`)
  return isNaN(+d) ? iso : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

/** The rating card (as the TVs' in the player): in the middle over a soft dimming, a glass card (How
 * was it?, the title in the display font) with three glass discs; the one you'd given lit in gold, and
 * picked again it clears. Escape or a click outside puts it away; Left and Right move between them. */
function RatingCard({ title, mine, onPick, onClose }: { title: string; mine: -1 | 1 | 2 | null; onPick: (v: -1 | 1 | 2) => void; onClose: () => void }) {
  const row = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const buttons = () => Array.from(row.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])
    buttons()[mine === -1 ? 0 : mine === 2 ? 2 : 1]?.focus()
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      const list = buttons(), at = list.indexOf(document.activeElement as HTMLButtonElement)
      list[Math.max(0, Math.min(list.length - 1, at + (e.key === 'ArrowRight' ? 1 : -1)))]?.focus()
      e.preventDefault()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose, mine])
  return (
    <div className="rate-scrim" onClick={onClose}>
      <div className="rate-box" role="dialog" aria-label={`Rate ${title}`} onClick={e => e.stopPropagation()}>
        <span className="rate-eyebrow">How was it?</span>
        <b className="rate-title">{title}</b>
        <div ref={row} className="rate-choices">
          {([-1, 1, 2] as const).map(v => (
            <button key={v} className={`rate-choice${mine === v ? ' mine' : ''}`} onClick={() => onPick(v)}
              aria-pressed={mine === v} title={mine === v ? 'Your rating: pick again to clear it' : undefined}>
              <span className="rate-disc"><Icon name={v === -1 ? 'rate_down' : v === 1 ? 'rate_up' : 'rate_love'} size={22} /></span>
              <span className="rate-label">{RATINGS[v]}</span>
            </button>
          ))}
        </div>
        <span className="rate-foot">{mine ? 'Your rating is lit · pick it again to clear it' : 'Helps pick what comes next for you'}</span>
      </div>
    </div>
  )
}

/** A button whose long press on a touch screen opens its card's menu (the ⋯ menu). */
function HoldButton({ menu, children, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { menu?: () => void }) {
  const press = useLongPress(menu)
  return <button {...rest} {...press}>{children}</button>
}

/** The page's shape while it comes: the top, then a row of posters (after 300 ms; a quick page
 * shows nothing in between). */
function TitleSkeleton() {
  const [shown, setShown] = useState(false)
  useEffect(() => { const t = setTimeout(() => setShown(true), 300); return () => clearTimeout(t) }, [])
  if (!shown) return <div className="title-page" />
  return (
    <div className="title-page" role="status" aria-label="Loading">
      <section className="title-top">
        <div className="title-text">
          <span className="skeleton skeleton-line" style={{ width: 120 }} />
          <span className="skeleton skeleton-line title-skeleton-name" />
          <span className="skeleton skeleton-line" style={{ width: 'min(420px, 70%)' }} />
        </div>
      </section>
      <div className="title-rows"><RowSkeleton /></div>
    </div>
  )
}
