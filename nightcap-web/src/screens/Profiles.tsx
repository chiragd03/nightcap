import { useEffect, useState, type CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import { profile } from '../api'
import { avatarOf, avatarSrc } from '../avatars'
import Icon from '../components/Icon'
import type { Profile } from '../types'
import './Profiles.css'
import { useLimits } from '../limits'
import { useSession } from '../session'

// As on the TV: the profiles in a row over a soft glow in the colour of the
// one you're on. The admin also gets "Add profile" and "Manage profiles".
const ADD_TINT = '#2A3344'
const DEFAULT_GLOW = '#2E3A4A'

/** The light a disc casts: its deep colour made brighter and richer (as on the TV). */
function glowOf(tint: string) {
  const n = parseInt(tint.slice(1), 16)
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(x => x / 255)
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min
  const h = d === 0 ? 0 : max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  const s = Math.min((max === 0 ? 0 : d / max) * 1.35, 0.85)
  const v = 0.78
  const f = (k: number) => {
    const x = (k + h + 6) % 6
    return Math.round((v - v * s * Math.max(0, Math.min(x, 4 - x, 1))) * 255)
  }
  return `rgb(${f(5)}, ${f(3)}, ${f(1)})`
}

function ProfilesScreen() {
  // (Only for "Add profile": the rest doesn't wait for the server's limits.)
  const lim = useLimits()
  // The household's profiles, as the session has them (asked for as the app opens; the last ones
  // known show meanwhile).
  const session = useSession()
  // (Asked again each time it opens, unless the session is asking already: a profile added or removed
  // on the TV shows here. The last ones known show meanwhile.)
  const asking = session.profiles === 'loading'
  const { reload } = session
  useEffect(() => { if (!asking) reload() }, [])
  const list = session.all.length || session.profiles === 'ready' ? session.all : undefined
  const failed = session.profiles === 'failed'
  const [on, setOn] = useState<string>()
  const [leaving, setLeaving] = useState<string>()
  const current = profile.get()
  const navigate = useNavigate()

  // Only the admin adds and removes profiles (nobody chosen yet isn't the admin).
  const admin = list?.find(p => p.id === current)?.isAdmin === true
  const focused = on ?? current ?? list?.[0]?.id
  const tintOf = (id?: string) => {
    if (id === 'add') return ADD_TINT
    const p = list?.find(x => x.id === id)
    return p ? avatarOf(p.avatar, p.id).tint : DEFAULT_GLOW
  }

  const choose = (p: Profile) => {
    if (leaving) return
    setLeaving(p.id)
    // A short pulse on the disc, the screen fades (Profiles.css: 70 ms + --dur), then Home.
    // Home in place of Who's watching (Back doesn't come here again), as the chosen profile.
    setTimeout(() => {
      if (p.id !== current) profile.set(p.id)
      navigate('/', { replace: true })
    }, 260)
  }

  return (
    <div className={`who${leaving ? ' leaving' : ''}`} style={{ '--glow': glowOf(tintOf(focused)) } as CSSProperties}>
      <div className="who-aura" aria-hidden />
      <div className="who-content">
        <h1>Who's watching?</h1>
        {!list && <p className="who-note">{failed ? "Couldn't reach the server." : 'Loading profiles…'}</p>}
        {!list && failed && <button className="who-manage" onClick={session.reload}>Try again</button>}
        <div className={`who-people${on ? ' has-focus' : ''}`} onMouseLeave={() => setOn(undefined)}>
          {list?.map((p, i) => {
            const a = avatarOf(p.avatar, p.id)
            return (
              <button
                key={p.id}
                className={`who-person${p.id === focused ? ' on' : ''}${p.id === leaving ? ' picked' : ''}`}
                style={{ '--tint': a.tint, '--i': i } as CSSProperties}
                onMouseEnter={() => setOn(p.id)}
                onFocus={() => setOn(p.id)}
                onClick={() => choose(p)}
              >
                <span className="who-disc">
                  <img src={avatarSrc(a.image)} alt="" />
                  <span className="who-ring" />
                </span>
                <span className="who-name">{p.name}</span>
              </button>
            )
          })}
          {admin && list && lim && list.length < lim.maxProfiles && (
            <button
              className={`who-person add${focused === 'add' ? ' on' : ''}`}
              style={{ '--tint': ADD_TINT, '--i': list.length } as CSSProperties}
              onMouseEnter={() => setOn('add')}
              onFocus={() => setOn('add')}
              onClick={() => navigate('/settings/profiles')}
            >
              <span className="who-disc">
                <span className="who-add"><Icon name="add" size={40} /></span>
                <span className="who-ring" />
              </span>
              <span className="who-name">Add profile</span>
            </button>
          )}
        </div>
        {admin && list && list.length > 1 && (
          <button className="who-manage" onClick={() => navigate('/settings/profiles')}>Manage profiles</button>
        )}
      </div>
      <p className="who-hint">You can switch profiles any time from the menu</p>
    </div>
  )
}

export default function Profiles() {
  return <ProfilesScreen />
}
