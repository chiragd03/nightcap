import { useEffect, useRef, type ReactNode } from 'react'
import type { IconName } from '../icons'
import Icon from './Icon'
import './Menu.css'

export type Action = { icon: IconName; label: string; run: () => void }

type Props = { title: ReactNode; subtitle?: ReactNode; actions: Action[]; onClose: () => void }

// The TV's long-press sheet: a glass list of actions for one card. Opens from a card's ⋯ button
// or a right-click; closes on Escape, outside clicks or picking an action.
export default function Menu({ title, subtitle, actions, onClose }: Props) {
  const box = useRef<HTMLDivElement>(null)
  // (Android sends its own touch-and-hold contextmenu up to 1.5 s after the long press opened this: that
  // one lands on the scrim, under the finger, and mustn't close it.)
  const openedAt = useRef(Date.now())
  useEffect(() => {
    box.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])

  return (
    <div className="menu-scrim" onClick={onClose} onContextMenu={e => { e.preventDefault(); if (Date.now() - openedAt.current > 1_600) onClose() }}>
      <div className="menu glass" ref={box} role="menu" onClick={e => e.stopPropagation()}>
        <div className="menu-head">
          <b>{title}</b>
          {subtitle && <span>{subtitle}</span>}
        </div>
        {actions.map(a => (
          <button key={a.label} role="menuitem" className="menu-item" onClick={() => { onClose(); a.run() }}>
            <Icon name={a.icon} size={20} />
            {a.label}
          </button>
        ))}
      </div>
    </div>
  )
}
