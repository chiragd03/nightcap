import type { IconName } from '../icons'
import Icon from './Icon'

/** A Connect tile: glass, an eyebrow, a line icon, a big name and a line under it. It grows
 * a little on focus, and the glow behind moves to its tint. */
export default function Tile({ label, name, sub, icon, leave, onFocus, onClick, focusable = true, autoFocus, first }: {
  label: string; name: string; sub: string; icon: IconName; leave?: boolean
  onFocus?: () => void; onClick?: () => void; focusable?: boolean; autoFocus?: boolean
  /** The first card of its row: Left from it opens the side panel. */
  first?: boolean
}) {
  return (
    <button className={`tile${leave ? ' leave' : ''}`} data-f={focusable ? '' : undefined} data-autofocus={autoFocus ? '' : undefined} data-first={first ? '' : undefined}
      tabIndex={focusable ? 0 : -1} onFocus={onFocus} onClick={focusable ? onClick : undefined}>
      <span className="tile-top">
        <span className="eyebrow">{label}</span>
        <Icon name={icon} size={22} className="tile-icon" />
      </span>
      <span className="tile-name">{name}</span>
      <span className="tile-sub">{sub}</span>
    </button>
  )
}
