import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { useInPlace } from './inplace'
import { focus as focusEl } from '../focus'
import type { Key } from '../keys'

// Rows of cards for title pages and Search, as Home's:
// the focused row at the top line (340 ms), the focused card pinned at the row's start (the
// row slides under it, 320 ms), rows above faded out, each row remembering its card, the title
// brightening on the focused row. Left on a row's first card opens the side panel; Right on its
// last does nothing. Holding OK (500 ms) opens a card's menu instead of opening it.

export type RowOf<C> = { id: string; title: string; kind: string; items: C[] }
export type RowFocus = { row: number; at: Record<string, number> }

const LONG_PRESS_MS = 500

export function CardRows<C extends { id: string }>({ rows, focus, onFocusCard, onPick, card, className }: {
  rows: RowOf<C>[]
  focus: RowFocus
  onFocusCard: (row: number, i: number) => void
  onPick: (row: number, i: number) => void
  /** A card's inside, by its row's kind; [load]: near enough to fetch pictures. */
  card: (row: RowOf<C>, item: C, i: number, load: boolean) => ReactNode
  className?: string
}) {
  const list = useRef<HTMLDivElement>(null)
  const [shift, setShift] = useState(0)
  useLayoutEffect(() => {
    const el = list.current?.children[focus.row] as HTMLElement | undefined
    setShift(el ? el.offsetTop : 0)
  }, [focus.row, rows])
  return (
    <div className={`rows ${className ?? ''}`}>
      <div ref={list} className="rows-list" style={{ transform: `translateY(${-shift}px)` }}>
        {rows.map((r, i) => (
          <OneRow key={r.id} row={r} index={i} focused={focus.row === i} above={i < focus.row}
            near={i >= focus.row - 1 && i <= focus.row + 3} at={Math.min(focus.at[r.id] ?? 0, r.items.length - 1)}
            onFocusCard={onFocusCard} onPick={onPick} card={card} />
        ))}
      </div>
    </div>
  )
}

const OneRow = memo(function OneRow<C extends { id: string }>({ row, index, focused, above, near, at, onFocusCard, onPick, card }: {
  row: RowOf<C>; index: number; focused: boolean; above: boolean; near: boolean; at: number
  onFocusCard: (row: number, i: number) => void; onPick: (row: number, i: number) => void
  card: (row: RowOf<C>, item: C, i: number, load: boolean) => ReactNode
}) {
  const track = useRef<HTMLDivElement>(null)
  const [shift, setShift] = useState(0)
  const seen = useRef(new Set<string>())
  useLayoutEffect(() => {
    const cards = track.current?.querySelectorAll<HTMLElement>(':scope > [data-i]')
    const c = cards?.[Math.max(0, at)]
    const first = cards?.[0]
    setShift(c && first ? c.offsetLeft - first.offsetLeft : 0)
  }, [at, row.items])
  useInPlace(track, row.items)
  // (A card's key is its id, with a count for an id the row has twice, so cards keep their element
  // when others come and go, and can slide.)
  const seenIds = new Map<string, number>()
  return (
    <div className={`row row-${row.kind}${focused ? ' focused' : ''}${above ? ' above' : ''}`}>
      <span className="row-title">{row.title}</span>
      <div ref={track} className="row-track" style={{ transform: `translateX(${-shift}px)` }}>
        {row.items.map((it, i) => {
          const load = (near && i >= at - 2 && i <= at + 10) || seen.current.has(it.id)
          if (load) seen.current.add(it.id)
          const n = seenIds.get(it.id) ?? 0
          seenIds.set(it.id, n + 1)
          const key = n ? `${it.id}#${n}` : it.id
          return (
            <button key={key} data-key={key} className={`card ${row.kind}-card`} data-f="" data-row={index} data-i={i}
              data-first={i === 0 ? '' : undefined} onFocus={() => onFocusCard(index, i)} onClick={() => onPick(index, i)}>
              {card(row, it, i, load)}
            </button>
          )
        })}
      </div>
    </div>
  )
}) as <C extends { id: string }>(p: {
  row: RowOf<C>; index: number; focused: boolean; above: boolean; near: boolean; at: number
  onFocusCard: (row: number, i: number) => void; onPick: (row: number, i: number) => void
  card: (row: RowOf<C>, item: C, i: number, load: boolean) => ReactNode
}) => ReactNode

/** The rows' focus and keys. [menuFor]: a card's long-press menu (none: OK opens at once). */
export function useCardRows<C extends { id: string }>({ root, rows, front, onOpen, hasMenu, onMenu, onLeftEdge }: {
  root: RefObject<HTMLElement | null>
  rows: RowOf<C>[]
  front: boolean
  onOpen: (row: number, i: number) => void
  hasMenu: (row: number, i: number) => boolean
  onMenu: (row: number, i: number) => void
  onLeftEdge: () => void
}) {
  const [focus, setFocus] = useState<RowFocus>({ row: 0, at: {} })
  const latest = useRef({ rows, focus, onOpen, hasMenu, onMenu, onLeftEdge })
  latest.current = { rows, focus, onOpen, hasMenu, onMenu, onLeftEdge }

  // Focus goes to a card once it's drawn.
  const [want, setWant] = useState<{ row: number; i: number; n: number } | null>(null)
  const focusCard = useCallback((row: number, i: number) => setWant(w => ({ row, i, n: (w?.n ?? 0) + 1 })), [])
  // (Used once: a redraw afterwards mustn't pull focus back to it, e.g. after Up to the search box.)
  const used = useRef(0)
  useEffect(() => {
    if (!want || !front || used.current === want.n) return
    const el = root.current?.querySelector<HTMLElement>(`[data-row="${want.row}"][data-i="${want.i}"]`)
    if (el && focusEl(el)) used.current = want.n
  }, [want, rows, front])

  const onFocusCard = useCallback((row: number, i: number) => {
    setFocus(f => {
      const r = latest.current.rows[row]
      if (!r) return f
      return f.row === row && f.at[r.id] === i ? f : { row, at: { ...f.at, [r.id]: i } }
    })
  }, [])

  // OK: short opens, held (500 ms) opens the menu. Remotes repeat OK while held, then send it up.
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; row: number; i: number; long: boolean } | null>(null)
  useEffect(() => {
    const up = (e: KeyboardEvent) => {
      if (e.keyCode !== 13 && e.key !== 'Enter') return
      const p = press.current
      if (!p) return
      press.current = null
      clearTimeout(p.timer)
      if (!p.long) latest.current.onOpen(p.row, p.i)
    }
    window.addEventListener('keyup', up)
    return () => window.removeEventListener('keyup', up)
  }, [])

  /** The arrows and OK on a card; true when taken. */
  const onKey = useCallback((key: Key, e: KeyboardEvent): boolean | void => {
    const active = document.activeElement as HTMLElement | null
    if (!active?.dataset.row || !root.current?.contains(active)) return
    const { rows: rs, focus: f } = latest.current
    const r = Number(active.dataset.row), i = Number(active.dataset.i)
    const row = rs[r]
    if (!row) return
    const to = (n: number) => {
      const target = rs[n]
      if (target) focusCard(n, Math.min(f.at[target.id] ?? 0, target.items.length - 1))
    }
    switch (key) {
      case 'up': to(r - 1); return true
      case 'down': to(r + 1); return true
      case 'left': if (i === 0) latest.current.onLeftEdge(); else focusCard(r, i - 1); return true
      case 'right': if (i < row.items.length - 1) focusCard(r, i + 1); return true
      case 'ok': {
        if (e.repeat || press.current) return true
        if (!latest.current.hasMenu(r, i)) { latest.current.onOpen(r, i); return true }
        const p = { row: r, i, long: false, timer: setTimeout(() => { p.long = true; latest.current.onMenu(r, i) }, LONG_PRESS_MS) }
        press.current = p
        return true
      }
    }
  }, [])

  return { focus, setFocus, focusCard, onFocusCard, onKey }
}
