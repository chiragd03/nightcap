import { useEffect, useRef } from 'react'
import { focus, focusFirst } from '../focus'
import type { IconName } from '../icons'
import { useKeys } from '../nav'
import * as profiles from '../profiles'
import Icon from './Icon'
import './Rail.css'

// The side panel, on Home, Search and title pages: who's
// watching, then Search, Home, its Shows and Movies pages, Live TV and Settings. Closed it's invisible and can't take focus; Left on a
// row's first card opens it (focus on this page's entry); Right or Back closes it, back to where
// focus was. Up and Down stay inside it. (The Android TV's Apps entry lists the TV's other apps,
// which Samsung and LG don't let an app do: it's left out.)

export type Entry = 'profile' | 'search' | 'home' | 'shows' | 'movies' | 'live' | 'settings'

/** Home's page an entry is (Home, Shows, Movies), if it's one: from another screen, nav.popToRoot(it). */
export const homePage = (e: Entry) => (e === 'home' ? 'home' : e === 'shows' ? 'tv' : e === 'movies' ? 'movie' : null)

const ENTRIES: { key: Entry; label: string; icon: IconName }[] = [
  { key: 'search', label: 'Search', icon: 'nav_search' },
  { key: 'home', label: 'Home', icon: 'nav_home' },
  { key: 'shows', label: 'Shows', icon: 'nav_shows' },
  { key: 'movies', label: 'Movies', icon: 'nav_movies' },
  { key: 'live', label: 'Live TV', icon: 'nav_live' },
  { key: 'settings', label: 'Settings', icon: 'nav_settings' },
]

export default function Rail({ open, page, onClose, onPick }: {
  open: boolean
  /** This page's entry, focused when the panel opens. */
  page: Entry
  onClose: () => void
  onPick: (entry: Entry) => void
}) {
  const card = useRef<HTMLDivElement>(null)
  // What had focus before the panel opened, to go back to.
  const before = useRef<HTMLElement | null>(null)
  const me = open ? profiles.current() : undefined
  const a = me && profiles.avatar(me)

  useEffect(() => {
    if (!open) return
    before.current = document.activeElement as HTMLElement | null
    const t = setTimeout(() => focus(card.current?.querySelector<HTMLElement>(`[data-entry="${page}"]`)) || focusFirst(card.current), 0)
    return () => clearTimeout(t)
  }, [open])

  const close = () => {
    onClose()
    setTimeout(() => {
      const was = before.current
      if (!(was && was.isConnected && focus(was))) focusFirst()
    }, 0)
  }

  useKeys(key => {
    if (key === 'back' || key === 'right') { close(); return true }
    if (key === 'left') return true
  }, open)

  return (
    <div className={`rail${open ? ' open' : ''}`} aria-hidden={!open}>
      <div className="rail-shade" />
      <div ref={card} className="rail-card" data-scope={open ? '' : undefined} hidden={!open}>
        {me && a && (
          <button className="rail-item rail-profile" data-f="" data-entry="profile" onClick={() => onPick('profile')}>
            <span className="rail-disc" style={{ background: a.tint }}><img src={profiles.avatarSrc(a.image)} alt="" /></span>
            <span className="rail-who"><b>{me.name}</b><small>Switch profile</small></span>
          </button>
        )}
        {ENTRIES.map(e => (
          <button key={e.key} className="rail-item" data-f="" data-entry={e.key} onClick={() => onPick(e.key)}>
            <Icon name={e.icon} size={22} /><span>{e.label}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
