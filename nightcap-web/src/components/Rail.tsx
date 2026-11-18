import { useState } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { signOut } from '../api'
import { avatarOf, avatarSrc } from '../avatars'
import type { IconName } from '../icons'
import { useSession } from '../session'
import Icon from './Icon'
import Menu from './Menu'
import './Rail.css'

// The TV's side panel: who's watching on top, then search, home and its Shows and Movies pages, Live
// TV, sent and settings, and signing this browser out last. Slim until the pointer is on it, then a
// glass panel with labels. A bottom bar on phones (without signing out: that's at the bottom of
// Settings there; nor Shows and Movies: they're tabs at the top of Home there, see PageTabs).
const ENTRIES: { to: string; label: string; icon: IconName; end?: boolean; wide?: boolean }[] = [
  { to: '/search', label: 'Search', icon: 'nav_search' },
  { to: '/', label: 'Home', icon: 'nav_home', end: true },
  { to: '/shows', label: 'Shows', icon: 'nav_shows', wide: true },
  { to: '/movies', label: 'Movies', icon: 'nav_movies', wide: true },
  { to: '/live', label: 'Live TV', icon: 'nav_live' },
  { to: '/sent', label: 'Sent to TV', icon: 'nav_phone' },
  { to: '/settings', label: 'Settings', icon: 'nav_settings' },
]

export default function Rail() {
  const { me } = useSession()
  const navigate = useNavigate()
  // (On a phone, Shows and Movies are tabs of Home: its entry stays lit on them.)
  const onHomePage = ['/shows', '/movies'].includes(useLocation().pathname)
  const [asking, setAsking] = useState(false)
  const avatar = me && avatarOf(me.avatar, me.id)
  // Picking an entry closes the panel, as on the TV; it opens again once the pointer has left.
  const [closed, setClosed] = useState(false)
  const pick = () => {
    setClosed(true)
    ;(document.activeElement as HTMLElement | null)?.blur()
  }

  return (
    <nav className="rail" aria-label="Main">
      <div className={`rail-panel${closed ? ' closed' : ''}`} onMouseLeave={() => setClosed(false)} onClick={pick}>
        <NavLink to="/profiles" className="rail-item rail-profile" title="Who's watching">
          <span className="rail-avatar" style={{ background: avatar?.tint }}>
            {avatar && <img src={avatarSrc(avatar.image)} alt="" />}
          </span>
          <span className="rail-label">
            <b>{me?.name ?? "Who's watching"}</b>
            {me && <small>Switch profile</small>}
          </span>
        </NavLink>
        {ENTRIES.map(e => (
          <NavLink key={e.to} to={e.to} end={e.end} className={`rail-item${e.wide ? ' rail-wide' : ''}${e.to === '/' && onHomePage ? ' home-page' : ''}`}>
            <span className="rail-icon"><Icon name={e.icon} /></span>
            <span className="rail-label">{e.label}</span>
          </NavLink>
        ))}
        <button type="button" className="rail-item rail-signout" onClick={() => setAsking(true)}>
          <span className="rail-icon"><Icon name="nav_sign_out" /></span>
          <span className="rail-label">Sign out</span>
        </button>
      </div>
      {asking && (
        <Menu title="Sign out of this browser?" subtitle="This browser leaves the household and forgets everything here. To sign in again you'll need a new invite from the household's admin or the server owner."
          actions={[{ icon: 'act_remove', label: 'Sign out', run: () => { signOut().then(() => navigate('/', { replace: true })) } },
                    { icon: 'act_close', label: 'Stay signed in', run: () => {} }]}
          onClose={() => setAsking(false)} />
      )}
    </nav>
  )
}
