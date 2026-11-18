import { memo, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Item, Row } from '../types'
import Shelf from './Shelf'
import { useLongPress } from './longPress'
import Img from './Img'

type Props = { row: Row; onFocus: (item: Item) => void; onMenu?: (row: Row, item: Item) => void }

function href(item: Item) {
  return item.type === 'tile' ? `/browse/${encodeURIComponent(item.id)}` : `/title/${item.type}/${item.id}`
}

// One Home row: posters, a ranked Top 10, or Browse tiles.
// (Drawn again only when its own row changes: Home's other changes, a peek, a menu, leave it be.)
const RowView = memo(function RowView({ row, onFocus, onMenu }: Props) {
  const style = row.style ?? 'posters'
  return (
    <Shelf title={row.title} className={style} scrollKey={row.items.length}>
      {row.items.map(item => (
        <RowItem key={item.id} row={row} item={item} style={style} onFocus={onFocus}
          menu={onMenu && item.type !== 'tile' ? () => onMenu(row, item) : undefined} />
      ))}
    </Shelf>
  )
})
export default RowView

/** One card of a row; a long press opens its menu on a touch screen. */
function RowItem({ row, item, style, onFocus, menu }: { row: Row; item: Item; style: string; onFocus: (item: Item) => void; menu?: () => void }) {
  const press = useLongPress(menu)
  return (
    <Link
      to={href(item)}
      state={{ from: row.id }}
      className="card"
      onMouseEnter={() => onFocus(item)}
      onFocus={() => onFocus(item)}
      onContextMenu={e => { if (menu) { e.preventDefault(); menu() } }}
      {...press}
    >
      {style === 'ranked' && <span className="card-rank">{item.rank}</span>}
      {style === 'tiles' ? (
        <div className="tile" style={{ backgroundImage: item.backdrop ? `url(${item.backdrop})` : undefined }}>
          <span>{item.name}</span>
        </div>
      ) : (
        <div className="poster">
          <Img src={item.poster} alt={item.name} fallback={<span>{item.name}</span>} />
          {(item.episode || !!item.newEpisodes) && (
            <span className="card-chips">
              {item.episode && <span className="chip-episode">{item.episode}</span>}
              {item.newEpisodes ? <span className="badge">+{item.newEpisodes}</span> : null}
            </span>
          )}
          {item.progress ? <span className="progress"><span style={{ width: `${item.progress * 100}%` }} /></span> : null}
          {menu && (
            <span className="card-more" role="button" aria-label="More"
              onClick={e => { e.preventDefault(); e.stopPropagation(); menu() }}>⋯</span>
          )}
        </div>
      )}
    </Link>
  )
}

/** Cards waiting for their row: the same size as the real ones, gently shimmering. */
export function RowSkeleton({ title, style = 'posters', cards = 9 }: { title?: string; style?: Row['style'] | 'posters'; cards?: number }) {
  return (
    <section className="row" aria-hidden>
      <div className="row-head">
        {title ? <h2 className="row-title">{title}</h2> : <span className="row-title skeleton skeleton-line" />}
      </div>
      <div className="row-track">
        <div className={`row-cards ${style ?? ''}`}>
          {Array.from({ length: cards }, (_, i) => (
            <div key={i} className="card"><div className="poster skeleton" style={{ animationDelay: `${i * 80}ms` }} /></div>
          ))}
        </div>
      </div>
    </section>
  )
}

// How far ahead of the screen a row is drawn (so it's ready before it's scrolled to).
const AHEAD = '900px 0px'

/** A Home row drawn only once it's near the screen (Home has up to 30): until then its title and
 * shimmering cards of the same size, so the page keeps its length and nothing jumps. Once drawn,
 * it stays. [eager]: drawn straight away (the rows on screen at first). */
export const LazyRow = memo(function LazyRow({ eager, ...props }: Props & { eager?: boolean }) {
  const [shown, setShown] = useState(!!eager || typeof IntersectionObserver === 'undefined')
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (shown || !box.current) return
    const seen = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) { setShown(true); seen.disconnect() }
    }, { rootMargin: AHEAD })
    seen.observe(box.current)
    return () => seen.disconnect()
  }, [shown])
  if (shown) return <RowView {...props} />
  return <div ref={box}><RowSkeleton title={props.row.title} style={props.row.style} /></div>
})
