import { useEffect, useRef, useState } from 'react'
import type { IconName } from '../icons'
import { focus, focusFirst } from '../focus'
import { useKeys } from '../nav'
import Icon from './Icon'
import './Sheet.css'

// The glass menu: a title, a line under it, and choices. Up and Down move (and
// stop at the ends), Left and Right do nothing, OK picks, Back closes it. Focus goes back to what
// opened it before it's gone.

export type Choice = { icon: IconName; label: string; run: () => void }

export default function Sheet({ title, subtitle, choices, onClose }: {
  title: string; subtitle?: string; choices: Choice[]; onClose: () => void
}) {
  const opener = useRef(document.activeElement as HTMLElement | null)
  const box = useRef<HTMLDivElement>(null)
  const [closing, setClosing] = useState(false)
  useEffect(() => { focusFirst(box.current) }, [])

  const close = (then?: () => void) => {
    if (closing) return
    focus(opener.current)
    setClosing(true)
    setTimeout(() => { onClose(); then?.() }, 150)
  }
  useKeys(key => {
    if (key === 'back') { close(); return true }
    if (key === 'left' || key === 'right') return true
  })

  return (
    <div className={`sheet-dim${closing ? ' closing' : ''}`}>
      <div ref={box} className="sheet" data-scope="" role="menu" aria-label={title}>
        <b className="sheet-title">{title}</b>
        {subtitle && <span className="sheet-sub">{subtitle}</span>}
        {choices.map(c => (
          <button key={c.label} className="sheet-item" data-f="" role="menuitem" onClick={() => close(c.run)}>
            <Icon name={c.icon} size={16} /> {c.label}
          </button>
        ))}
      </div>
    </div>
  )
}
