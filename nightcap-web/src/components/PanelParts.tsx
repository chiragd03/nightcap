import type { CSSProperties, ReactNode } from 'react'
import type { IconName } from '../icons'
import Icon from './Icon'

// The pieces of the glass side panels (Settings' household pages, the server owner's): compact
// rows that open a page, the top of that page, and its choices as pills, as in the TV's menus.

export type Status = 'testing' | 'ok' | 'bad' | 'warn' | undefined

/** A source's mark: two letters on a disc whose colour comes from its name (steady). The second
 * is the next capital a little way in ("AIOStreams" AS, "DesiFlix" DF), so acronyms don't read "AI". */
export function Mark({ name, big }: { name: string; big?: boolean }) {
  const flat = name.replace(/\s+/g, '')
  const second = flat.slice(3).match(/[A-Z]/)?.[0] ?? flat[1] ?? ''
  const letters = flat.length <= 2 ? flat.toUpperCase() : (flat[0] + second).toUpperCase()
  let h = 0
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360
  return <span className={`mark${big ? ' big' : ''}`} style={{ '--hue': h } as CSSProperties} aria-hidden>{letters}</span>
}

/** One compact row: a mark, the name, a quiet line under it, and a status dot. Opens its page. */
export function Row({ mark, name, sub, status, badge, onClick }: {
  mark: ReactNode; name: string; sub?: string; status?: Status; badge?: string; onClick: () => void
}) {
  return (
    <button className="pn-item row-item" onClick={onClick}>
      {mark}
      <span className="pn-label"><b>{name}{badge && <em className="pn-this">{badge}</em>}</b>{sub && <small>{sub}</small>}</span>
      {status && <span className={`dot ${status}`} aria-label={STATUS_WORDS[status]} title={STATUS_WORDS[status]} />}
      <Icon name="chevron" size={14} />
    </button>
  )
}
const STATUS_WORDS: Record<NonNullable<Status>, string> = { testing: 'Testing', ok: 'Works', bad: "Didn't work", warn: 'Failed lately' }

export function AddRow({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button className="pn-item row-item add" onClick={onClick}>
      <span className="mark add" aria-hidden><Icon name="add" size={13} /></span>
      <span className="pn-label"><b>{children}</b></span>
    </button>
  )
}

/** The top of one source's or device's page. */
export function Detail({ mark, name, lines, status, badge, mono }: {
  mark: ReactNode; name: string; lines: string[]; status?: Status; badge?: string; mono?: boolean
}) {
  return (
    <div className="pn-detail">
      {mark}
      <b>{name}{status && <span className={`dot ${status}`} />}</b>
      {badge && <em className="pn-this">{badge}</em>}
      {lines.map((l, i) => <span key={i} className={i === 0 && mono ? 'mono' : ''}>{l}</span>)}
    </div>
  )
}

/** A choice on a page, as in the TV's menus: an icon and a label on a pill. */
export function Pill({ icon, danger, sub, onClick, children }: {
  icon: IconName; danger?: boolean; sub?: string; onClick: () => void; children: ReactNode
}) {
  return (
    <button className={`pn-item action${danger ? ' danger' : ''}`} onClick={onClick}>
      <span className="pn-tick"><Icon name={icon} size={16} /></span>
      <span className="pn-label"><b>{children}</b>{sub && <small>{sub}</small>}</span>
    </button>
  )
}

/** Back to where [children] names: a round button, with this page's own [title] beside it (or, without
 * one, where it goes back to). */
export const Back = ({ onClick, children, title }: { onClick: () => void; children: ReactNode; title?: ReactNode }) => (
  <div className="pn-backbar">
    <button type="button" className="pn-back" onClick={onClick} aria-label={typeof children === 'string' ? `Back to ${children}` : 'Back'}>
      <Icon name="chevron" size={18} />
    </button>
    <span className="pn-backtitle">{title ?? children}</span>
  </div>
)

