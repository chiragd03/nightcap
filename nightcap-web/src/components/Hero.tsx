import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import * as api from '../api'
import type { Item } from '../types'
import Icon from './Icon'
import Img from './Img'
import { wide } from '../images'
import './Hero.css'

// As on the TV: the featured carousel moves on every 8 seconds.
const ADVANCE_MS = 8000

type Props = { featured: Item[]; peek?: Item; onEnter?: () => void; onLeave?: () => void; onPlayOnTv?: (item: Item) => void }

// The big picture behind Home: the featured carousel, or the title under the pointer ([peek]).
export default function Hero({ featured, peek, onEnter, onLeave, onPlayOnTv }: Props) {
  // The title showing, by id: a fresh Home (the kept one replaced by the server's) keeps it on screen,
  // wherever it is in the new list; one no longer featured stays until the carousel moves on.
  const [held, setHeld] = useState<Item | undefined>(featured[0])
  const [paused, setPaused] = useState(false)
  const at = featured.findIndex(f => f.id === held?.id)
  const page = at >= 0 ? at : held ? -1 : 0
  const setPage = (i: number) => setHeld(featured[i])

  useEffect(() => {
    if (peek || paused || featured.length < 2) return
    const t = setTimeout(() => setHeld(featured[(page + 1) % featured.length]), ADVANCE_MS)
    return () => clearTimeout(t)
  }, [page, peek, paused, featured])

  // The next picture, fetched while this one shows (only while the tab is in view), so the change
  // shows it at once.
  useEffect(() => {
    const next = featured[(page + 1) % featured.length]?.backdrop
    if (featured.length < 2 || !next) return
    const t = setTimeout(() => {
      if (document.visibilityState !== 'visible') return
      const img = new Image()
      const { srcSet, sizes } = wide(next)
      if (sizes) img.sizes = sizes
      if (srcSet) img.srcset = srcSet
      img.src = next
    }, 1500)
    return () => clearTimeout(t)
  }, [page, featured])

  const wanted = peek ?? (page >= 0 ? featured[page] : held) ?? featured[0]
  // (The picture changes once the next one is ready to draw: never a moment of nothing between.)
  const item = useReady(wanted)
  if (!item) return <section className="hero" />
  const facts = [item.year, item.rating ? `★ ${item.rating}` : null, item.episode].filter(Boolean).join('  ·  ')
  const isTitle = item.type === 'movie' || item.type === 'series'

  return (
    <section className="hero" onMouseEnter={() => { setPaused(true); onEnter?.() }} onMouseLeave={() => { setPaused(false); onLeave?.() }}>
      {item.backdrop && <Img key={item.backdrop} className="hero-art" {...wide(item.backdrop)} main />}
      <div className="hero-scrim" />
      <div className="hero-text" key={item.id}>
        {item.label && <div className="eyebrow hero-label">{item.label}</div>}
        <h1>{item.name}</h1>
        {facts && <div className="hero-facts">{facts}</div>}
        <p>{item.reason ?? item.overview}</p>
        {isTitle && (
          <div className="hero-actions">
            <Link className="btn primary" to={playLink(item)} state={{ art: item.backdrop }}>
              <Icon name="play" size={18} /> Play
            </Link>
            <button className="btn" onClick={() => onPlayOnTv?.(item)}>Play on TV</button>
            <Link className="btn" to={`/title/${item.type}/${item.id}`}>More info</Link>
          </div>
        )}
        {featured.length > 1 && (
          // Hidden, not removed, while peeking, so the text doesn't jump.
          <div className="hero-dots" role="tablist" aria-label="Featured" style={{ visibility: peek ? 'hidden' : undefined }}>
            {featured.map((f, i) => (
              <button
                key={f.id}
                role="tab"
                aria-selected={i === page}
                aria-label={f.name}
                className={i === page ? 'on' : ''}
                onClick={() => setPage(i)}
              >
                {i === page && !paused && <span style={{ animationDuration: `${ADVANCE_MS}ms` }} />}
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

/** Play from Home: the episode you're on, or the film; a show not started yet opens its page. */
function playLink(item: Item) {
  if (item.type === 'movie') return `/watch/movie/${item.id}`
  if (item.videoId) return `/watch/series/${encodeURIComponent(item.videoId)}`
  return `/title/${item.type}/${item.id}`
}

/** What Play on TV sends from Home: the episode you're on, or the title. */
export const playWhat = (item: Item) => api.titleToPlay(item.type === 'series' ? 'series' : 'movie', item.id, item.videoId)

/** [item], or the one before it until [item]'s picture is fetched and ready to draw. */
function useReady(item: Item | undefined) {
  const [ready, setReady] = useState(item)
  const src = item?.backdrop
  useEffect(() => {
    if (!src) { setReady(item); return }
    let gone = false
    const img = new Image()
    const { srcSet, sizes } = wide(src)
    if (sizes) img.sizes = sizes
    if (srcSet) img.srcset = srcSet
    img.src = src
    // (A picture that can't load doesn't hold the title up.)
    img.decode().catch(() => {}).then(() => { if (!gone) setReady(item) })
    return () => { gone = true }
  }, [item, src])
  return ready?.id === item?.id ? item : ready
}
