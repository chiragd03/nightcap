import { memo, useLayoutEffect, useRef, useState } from 'react'
import type { Item, Row } from '../feed'
import { useInPlace } from '../ui/inplace'
import PosterImg from '../ui/PosterImg'

// Home's rows. The focused row sits at the top of the list (the list slides,
// 340 ms); in a row, the focused card stays at the start and the row slides under it (320 ms).
// Rows above the focused one fade out. Card types: posters, the Top 10's ranked posters, Browse
// tiles; the featured carousel is a strip of dots (its title fills the hero). Pictures load only
// for cards near what's on screen, and stay once loaded while their row is near (Home has up to 30
// rows: rows far from the focused one let theirs go, so a 2020 TV doesn't hold hundreds of pictures;
// they come back from the browser's cache). Cards changing in place slide and fade (ui/inplace).

export type Focus = { row: number; at: Record<string, number>; featured: number }

export function Rows({ rows, focus, onFocusCard, onPick }: {
  rows: Row[]
  focus: Focus
  onFocusCard: (row: number, index: number) => void
  onPick: (row: number, index: number) => void
}) {
  const list = useRef<HTMLDivElement>(null)
  const [shift, setShift] = useState(0)
  useLayoutEffect(() => {
    const el = list.current?.children[focus.row] as HTMLElement | undefined
    setShift(el ? el.offsetTop : 0)
  }, [focus.row, rows])

  return (
    <div className="rows">
      <div ref={list} className="rows-list" style={{ transform: `translateY(${-shift}px)` }}>
        {rows.map((r, i) => (
          <RowView key={r.id} row={r} index={i} focused={focus.row === i} above={i < focus.row}
            near={i >= focus.row - 1 && i <= focus.row + 3} keep={i >= focus.row - KEEP_ABOVE && i <= focus.row + KEEP_BELOW}
            at={r.id === 'featured' ? focus.featured : focus.at[r.id] ?? 0}
            onFocusCard={onFocusCard} onPick={onPick} />
        ))}
      </div>
    </div>
  )
}

// Rows whose pictures stay loaded, around the focused one.
const KEEP_ABOVE = 3
const KEEP_BELOW = 6

const RowView = memo(function RowView({ row, index, focused, above, near, keep, at, onFocusCard, onPick }: {
  row: Row; index: number; focused: boolean; above: boolean; near: boolean; keep: boolean; at: number
  onFocusCard: (row: number, index: number) => void; onPick: (row: number, index: number) => void
}) {
  const track = useRef<HTMLDivElement>(null)
  const [shift, setShift] = useState(0)
  const seen = useRef(new Set<string>())
  if (!keep) seen.current.clear()
  useLayoutEffect(() => {
    const cards = track.current?.querySelectorAll<HTMLElement>(':scope > [data-i]')
    const card = cards?.[Math.min(at, (cards?.length ?? 1) - 1)]
    const first = cards?.[0]
    setShift(card && first ? card.offsetLeft - first.offsetLeft : 0)
  }, [at, row.items])
  // Cards changing in place slide, fade in and fade out.
  useInPlace(track, row.items)

  if (row.style === 'featured') {
    return (
      <div className={`row featured${above ? ' above' : ''}`}>
        <button className="dots" data-f="" data-row={index} data-i={at} aria-label="Featured"
          onFocus={() => onFocusCard(index, at)} onClick={() => onPick(index, at)}>
          {row.items.map((it, i) => <span key={it.id} className={`dot${i === at ? ' on' : ''}`} />)}
        </button>
      </div>
    )
  }

  const style = row.style === 'ranked' ? 'ranked' : row.style === 'tiles' ? 'tiles' : 'posters'
  return (
    <div className={`row row-${style}${focused ? ' focused' : ''}${above ? ' above' : ''}`}>
      <span className="row-title">{row.title}</span>
      <div ref={track} className="row-track" style={{ transform: `translateX(${-shift}px)` }}>
        {row.items.map((it, i) => {
          const load = (near && i >= at - 2 && i <= at + 10) || seen.current.has(it.id)
          if (load) seen.current.add(it.id)
          return (
            <Card key={it.id} item={it} style={style} load={load} row={index} i={i} first={i === 0}
              onFocusCard={onFocusCard} onPick={onPick} />
          )
        })}
      </div>
    </div>
  )
})

const Card = memo(function Card({ item, style, load, row, i, first, onFocusCard, onPick }: {
  item: Item; style: 'posters' | 'ranked' | 'tiles'; load: boolean; row: number; i: number; first: boolean
  onFocusCard: (row: number, index: number) => void; onPick: (row: number, index: number) => void
}) {
  const common = {
    'data-f': '', 'data-key': item.id, 'data-row': row, 'data-i': i, 'data-first': first ? '' : undefined,
    onFocus: () => onFocusCard(row, i), onClick: () => onPick(row, i),
  }
  if (style === 'tiles') {
    return (
      <button className="card tile-card" {...common}>
        <span className="poster" style={{ background: tileColour(item.id) }}>
          {load && <TileArt src={item.backdrop} />}
          <span className="tile-shade" />
          <span className="tile-text">
            {tileKind(item.id) && <small>{tileKind(item.id)}</small>}
            <b>{item.name}</b>
          </span>
          <span className="sheen" />
        </span>
      </button>
    )
  }
  const poster = (
    <span className="poster">
      {load && <PosterImg src={item.poster} name={item.name} />}
      {item.episode && <span className="chip ep">{item.episode}</span>}
      {!!item.newEpisodes && item.newEpisodes > 0 && !item.muted && <span className="chip new"><sup>+</sup>{item.newEpisodes}</span>}
      {!!item.progress && item.progress > 0.01 && (
        <span className="progress"><span style={{ transform: `scaleX(${Math.min(1, item.progress)})` }} /></span>
      )}
      <span className="sheen" />
    </span>
  )
  if (style === 'ranked') {
    return (
      <button className="card ranked-card" {...common}>
        <RankNumber rank={item.rank} />
        {poster}
      </button>
    )
  }
  return <button className="card poster-card" {...common}>{poster}</button>
})

/** A Browse tile's picture (its top title's backdrop), faded in once it's come; till then, or with
 * none, the tile's own colour shows. */
function TileArt({ src }: { src?: string | null }) {
  const [shown, setShown] = useState<string>()
  if (!src) return null
  return <img className={shown === src ? 'in' : undefined} src={src} alt="" onLoad={() => setShown(src)} />
}

/** What kind of Browse tile it is, by its id ("genre:28", "lang:hi", "top10:IN", "soon"). */
function tileKind(id: string) {
  const kind = id.split(':')[0]
  return kind === 'genre' ? 'Genre' : kind === 'lang' ? 'Language' : kind === 'top10' ? 'Chart' : kind === 'soon' ? 'New' : ''
}

/** A tile with no picture: a deep colour of its own, the same each time for the same tile. */
function tileColour(id: string) {
  let hue = 0
  for (let i = 0; i < id.length; i++) hue = (hue * 31 + id.charCodeAt(i)) % 360
  return `linear-gradient(to bottom left, ${hsv(hue, 0.55, 0.32)}, ${hsv((hue + 30) % 360, 0.6, 0.16)})`
}

function hsv(h: number, s: number, v: number) {
  const f = (n: number) => {
    const k = (n + h / 60) % 6
    return Math.round(255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))))
  }
  return `rgb(${f(5)}, ${f(3)}, ${f(1)})`
}

/** The Top 10's big number: the poster covers only the last sliver of its shape (a tenth of its
 * width, 7 dp at most), so "1" and "10" both stay readable. */
function RankNumber({ rank }: { rank?: number }) {
  const text = rank != null ? String(rank) : ''
  const el = useRef<HTMLSpanElement>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    if (!el.current) return
    const remPx = parseFloat(getComputedStyle(document.documentElement).fontSize)
    const ctx = document.createElement('canvas').getContext('2d')
    if (!ctx) return
    ctx.font = `800 ${150 * remPx}px 'Big Shoulders', sans-serif`
    const ink = ctx.measureText(text).width
    setWidth(Math.max(0, ink - Math.min(ink * 0.1, 7 * remPx)))
  }, [text])
  return <span ref={el} className="rank" style={{ width: `${width}px` }}>{text}</span>
}
