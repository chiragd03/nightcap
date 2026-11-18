import { useEffect, useRef, useState, type ReactNode } from 'react'
import Icon from './Icon'
import './RowView.css'

type Props = { title?: ReactNode; extra?: ReactNode; className?: string; scrollKey?: unknown; children: ReactNode }

// A horizontal row of cards with its title: swipes on phones, round arrows on desktop that show
// only where there's more to see. [scrollKey] changing re-measures (and returns to the start).
export default function Shelf({ title, extra, className = '', scrollKey, children }: Props) {
  const cards = useRef<HTMLDivElement>(null)
  const [more, setMore] = useState({ prev: false, next: false })
  // (Once a frame at most while scrolling, and only a change draws the row again.)
  const frame = useRef(0)
  const measure = () => {
    cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(() => {
      const el = cards.current
      if (!el) return
      const prev = el.scrollLeft > 4, next = el.scrollLeft + el.clientWidth < el.scrollWidth - 4
      setMore(m => (m.prev === prev && m.next === next ? m : { prev, next }))
    })
  }
  useEffect(() => () => cancelAnimationFrame(frame.current), [])
  useEffect(() => {
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [scrollKey])
  // Arrows page through the row by most of a screen width.
  const page = (dir: 1 | -1) => cards.current?.scrollBy({ left: dir * cards.current.clientWidth * 0.8, behavior: 'smooth' })

  return (
    <section className="row">
      {(title || extra) && (
        <div className="row-head">
          {title && <h2 className="row-title">{title}</h2>}
          {extra}
        </div>
      )}
      <div className="row-track">
        {more.prev && (
          <button className="row-arrow prev" aria-label="Scroll left" onClick={() => page(-1)}><Icon name="chevron" size={20} /></button>
        )}
        {more.next && (
          <button className="row-arrow next" aria-label="Scroll right" onClick={() => page(1)}><Icon name="chevron" size={20} /></button>
        )}
        <div className={`row-cards ${className}`} ref={cards} onScroll={measure}>
          {children}
        </div>
      </div>
    </section>
  )
}

/** Scrolls a row so its [index]th card is in view (the episode you're on). */
export function scrollCardIntoView(row: HTMLElement | null, index: number) {
  const card = row?.querySelectorAll<HTMLElement>('.row-cards > *')[index]
  card?.scrollIntoView({ block: 'nearest', inline: 'start' })
}
