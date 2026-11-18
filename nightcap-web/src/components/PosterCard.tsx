import { type MouseEvent } from 'react'
import { Link } from 'react-router-dom'
import type { Card } from '../types'
import { useLongPress } from './longPress'
import Img from './Img'

type Props = { card: Card; onPeek: () => void; onMenu: (e: MouseEvent) => void; onOpen?: () => void }

/** A title's poster on a page's rows (title, person, Browse, Search), with its ⋯ menu. */
export default function PosterCard({ card, onPeek, onMenu, onOpen }: Props) {
  const titled = card.type === 'movie' || card.type === 'series'
  // (A long press on a touch screen: the ⋯ menu, as on a row's card.)
  const press = useLongPress(titled ? () => onMenu({ preventDefault() {}, stopPropagation() {} } as MouseEvent) : undefined)
  return (
    <Link to={titled ? `/title/${card.type}/${card.id}` : '#'} className="card" onMouseEnter={onPeek} onFocus={onPeek}
      onContextMenu={onMenu} onClick={onOpen} {...press}>
      <div className="poster">
        {card.rank && <span className="badge rank-badge">#{card.rank}</span>}
        {/* (One that doesn't load shows the name, as one with none does.) */}
        <Img src={card.poster} alt={card.name} fallback={<span>{card.name}</span>} />
        {titled && <span className="card-more" role="button" aria-label="More" onClick={onMenu}>⋯</span>}
      </div>
    </Link>
  )
}
