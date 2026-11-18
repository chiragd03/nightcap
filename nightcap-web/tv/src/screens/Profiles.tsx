import { useEffect, useRef, useState, type ReactNode } from 'react'
import * as admin from '../admin'
import * as api from '../api'
import { focus, focusFirst } from '../focus'
import { useIsFront, useKeys, useNav, useOnFront } from '../nav'
import * as profiles from '../profiles'
import * as store from '../store'
import { AVATARS, type Profile } from '../profiles'
import AvatarCarousel from '../ui/AvatarCarousel'
import Aura from '../ui/Aura'
import Icon from '../ui/Icon'
import { notify } from '../ui/Notice'
import Sheet from '../ui/Sheet'
import Connect from './Connect'
import Home from './Home'
import './Profiles.css'
import * as keyboard from '../keyboard'
import { useLimits, useLimitsReady } from '../../../src/limits'

// Who's watching. Drawn at once from the list kept on
// this TV, then refreshed from the server. Picking a profile opens Home for it; from the side
// panel, picking the one already watching (or Back) just goes back. The admin can add profiles (up
// to six) and remove them, after the admin PIN.

const ADD_TINT = '#2A3344'

/** Whether Who's watching is the screen in front (so waking doesn't open it twice). */
export let profilesInFront = false

/** Opens Who's watching to ask who's there, unless it's already open or opening: set at once, not when
 * the screen mounts, so two asks in a row (waking, Home coming to the front) open it once. */
export function askWhoIsWatching(push: (el: ReactNode, plain?: boolean) => void, plain?: boolean) {
  if (profilesInFront) return
  profilesInFront = true
  whoMounted = false
  push(<Profiles />, plain)
  // (Pushed but never drawn, the stack reset in the same moment (Connect): not left marked open.)
  setTimeout(() => { if (!whoMounted) profilesInFront = false }, 1_000)
}
let whoMounted = false

function ProfilesScreen({ fromMenu }: { fromMenu?: boolean }) {
  // (Drawn without the server's limits too: when the server can't be reached it says so, with a way on.)
  const lim = useLimits()
  const nav = useNav()
  const [list, setList] = useState<Profile[]>(profiles.list)
  const [entering, setEntering] = useState(0)
  const [manage, setManage] = useState(false)
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState<Profile | null>(null)
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const [leaving, setLeaving] = useState<string | null>(null)
  const [tint, setTint] = useState('#2E3A4A')
  const busy = useRef(false)
  const row = useRef<HTMLDivElement>(null)
  const wantFocus = useRef<string | null>(null)
  const isAdmin = profiles.isAdmin()
  // No profiles to show yet: loading, or the server couldn't be reached (with a way on).
  const [status, setStatus] = useState<'loading' | 'failed' | null>(null)
  // Back with nobody chosen yet: said in place of the hint.
  const [pickFirst, setPickFirst] = useState(false)
  const shown = useRef(list)
  shown.current = list
  const front = useRef(false)
  front.current = useIsFront()

  useEffect(() => { profiles.asked() }, [])
  // The list kept on the TV first, then the server's, fetched again each time this is back in front
  // (a profile added or removed on the web, say); redrawn only if it changed.
  const load = () => {
    if (shown.current.length === 0) setStatus('loading')
    profiles.download().then(fresh => {
      if (!front.current) return
      // Nothing to show and the server couldn't be reached: said, with a way on.
      if (!fresh) {
        if (shown.current.length === 0) setStatus('failed')
        return
      }
      setStatus(null)
      // A new TV, and the household has just one profile: it's the one watching.
      if (!profiles.currentId() && fresh.length === 1) return carryOn(fresh[0])
      setList(was => {
        if (JSON.stringify(was) === JSON.stringify(fresh)) return was
        if (was.length === 0) setEntering(n => n + 1)
        return fresh
      })
    })
  }
  useOnFront(load)

  // Focus: a profile just added, else the one focused, else the one watching, else the first.
  useEffect(() => {
    if (adding) return
    const t = setTimeout(() => {
      const tiles = Array.from(row.current?.querySelectorAll<HTMLElement>('[data-id]') ?? [])
      const want = wantFocus.current ?? focusedId ?? profiles.currentId()
      const tile = tiles.find(t => t.dataset.id === want && t.hasAttribute('data-f'))
      if (tile) wantFocus.current = null
      if (!focus(tile)) focusFirst()
    }, 0)
    return () => clearTimeout(t)
  }, [list, manage, adding, status])

  // Carrying on: Home for this profile, everything above it closed and Home back
  // at the top; from the side panel with the same profile, just back.
  const carryOn = (p: Profile | undefined) => {
    if (fromMenu && (!p || p.id === profiles.currentId())) return nav.pop()
    if (p) profiles.choose(p)
    nav.reset(<Home key={profiles.currentId() ?? 'none'} />)
  }

  const pick = (p: Profile) => {
    if (leaving) return
    if (manage) { if (!p.isAdmin && !busy.current) setRemoving(p); return }
    setLeaving(p.id)
    setTimeout(() => carryOn(p), 360)
  }

  const addTile = async () => {
    if (busy.current) return
    if (await admin.ensure()) setAdding(true)
  }

  // Manage profiles asks for the admin PIN on the way in (the Android TV asks only at Remove).
  const toggleManage = async () => {
    if (manage) return setManage(false)
    if (busy.current) return
    busy.current = true
    try { if (await admin.ensure()) setManage(true) } finally { busy.current = false }
  }

  const remove = async (p: Profile) => {
    if (busy.current || !(await admin.ensure())) return
    busy.current = true
    try {
      await api.post('/launcher/profiles/delete', { id: p.id })
      notify(`Removed ${p.name}`)
      const fresh = await profiles.fetchList()
      const left = fresh.some(x => x.id === p.id) ? fresh.filter(x => x.id !== p.id) : fresh
      setList(left)
      if (left.length <= 1) setManage(false)
    } catch {
      notify(`Couldn't remove ${p.name}. Try again.`)
    } finally {
      busy.current = false
    }
  }

  useKeys(key => {
    if (leaving) return true
    if (key !== 'back' || removing) return
    if (adding) { if (!busy.current) setAdding(false); return true }
    if (manage) { setManage(false); return true }
    // Nobody chosen yet (a new TV with several profiles): there's no one to carry on as.
    if (!profiles.currentId()) {
      if (list.length) setPickFirst(true)
      return true
    }
    carryOn(profiles.list().find(p => p.id === profiles.currentId()))
    return true
  })

  const showAdd = !!lim && isAdmin && !manage && list.length < lim.maxProfiles
  const showManage = isAdmin && list.length > 1

  return (
    <div className={`who${leaving ? ' leaving' : ''}`}>
      <Aura tint={tint} />
      {!adding ? (
        <div className="who-body" key={entering}>
          <h1 className="who-title">{manage ? 'Manage profiles' : "Who's watching?"}</h1>
          <div ref={row} className={`who-row${focusedId ? ' has-focus' : ''}`}>
            {list.map((p, i) => {
              const a = profiles.avatar(p)
              const locked = manage && p.isAdmin
              return (
                <button key={p.id} data-id={p.id} className={`who-tile${locked ? ' locked' : ''}${leaving === p.id ? ' picked' : ''}`}
                  data-f={locked ? undefined : ''} tabIndex={locked ? -1 : 0} style={{ animationDelay: `${120 + 55 * i}ms` }}
                  onFocus={() => { setFocusedId(p.id); setTint(a.tint) }} onBlur={() => setFocusedId(null)} onClick={() => pick(p)}>
                  <span className="who-disc" style={{ background: a.tint }}>
                    <img src={profiles.avatarSrc(a.image)} alt="" />
                    {manage && !p.isAdmin && <span className="who-remove"><Icon name="act_remove" size={26} /></span>}
                  </span>
                  <span className="who-name">{p.name}</span>
                </button>
              )
            })}
            {showAdd && (
              <button data-id="add" className="who-tile" data-f="" style={{ animationDelay: `${120 + 55 * list.length}ms` }}
                onFocus={() => { setFocusedId('add'); setTint(ADD_TINT) }} onBlur={() => setFocusedId(null)} onClick={addTile}>
                <span className="who-disc add" style={{ background: ADD_TINT }}><Icon name="add" size={55} /></span>
                <span className="who-name">Add profile</span>
              </button>
            )}
          </div>
          {showManage && (
            <button className="pill who-manage" data-f="" onClick={toggleManage}>{manage ? 'Done' : 'Manage profiles'}</button>
          )}
          {status && list.length === 0 && (
            <p className="who-status">{status === 'loading' ? 'Loading profiles…' : `Couldn't reach ${store.household.get()?.trim() || 'the server'}.`}</p>
          )}
          {status === 'failed' && list.length === 0 && (
            <div className="who-actions">
              <button className="pill" data-f="" onClick={load}>Try again</button>
              <button className="pill" data-f="" onClick={() => nav.push(<Connect />)}>Change server</button>
            </div>
          )}
          {(pickFirst || !fromMenu) && <p className="who-hint">{pickFirst ? 'Pick a profile to start' : 'You can switch profiles any time from the menu'}</p>}
        </div>
      ) : (
        <Adder taken={list} onTint={setTint}
          onSaved={id => {
            wantFocus.current = id
            // (The new profile's tile is focused once the list with it is drawn.)
            profiles.fetchList().then(fresh => { setList(fresh); setAdding(false) })
          }}
          busy={busy} />
      )}
      {removing && (
        <Sheet title={`Remove ${removing.name}?`} subtitle="Their watch history, ratings and settings go too"
          choices={[{ icon: 'act_remove', label: 'Remove', run: () => remove(removing) }, { icon: 'act_close', label: 'Keep', run: () => {} }]}
          onClose={() => setRemoving(null)} />
      )}
    </div>
  )
}

/** Adding a profile: an avatar (the first no one uses), a name, Add. */
function Adder({ taken, onTint, onSaved, busy }: {
  taken: Profile[]; onTint: (tint: string) => void; onSaved: (id: string) => void; busy: { current: boolean }
}) {
  const lim = useLimitsReady()
  const used = new Set(taken.map(p => p.avatar))
  const [index, setIndex] = useState(() => Math.max(0, AVATARS.findIndex(a => !used.has(a.key))))
  const [name, setName] = useState('')
  const field = useRef<HTMLInputElement>(null)
  const addButton = useRef<HTMLButtonElement>(null)
  const a = AVATARS[index]
  useEffect(() => { onTint(a.tint) }, [a.tint])
  useEffect(() => { focusFirst() }, [])

  const label = a.key === 'invader' ? 'Space invader' : a.key.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase())

  const save = async () => {
    if (busy.current) return
    const clean = name.trim().replace(/\s+/g, ' ')
    if (!clean) { focus(field.current); notify('Type a name first'); return }
    if (!(await admin.ensure())) return
    busy.current = true
    try {
      const made = await api.post<{ id: string }>('/launcher/profiles', { name: clean, avatar: a.key })
      onSaved(made.id)
    } catch (e) {
      notify(e instanceof api.ServerError && e.status !== 0 && e.message ? e.message : "Couldn't add that profile. Try again.")
    } finally {
      busy.current = false
    }
  }

  useKeys((key, e) => {
    if (document.activeElement === field.current && key === 'ok' && keyboard.typing()) { e.preventDefault(); focus(addButton.current); return true }
  })

  return (
    <div className="adder">
      <h1 className="adder-title">Add profile</h1>
      <AvatarCarousel value={index} onChange={setIndex} onPick={() => focus(field.current)} />
      <span className="adder-label">{label}</span>
      <input ref={field} className="field adder-name" data-f="" placeholder="Name" maxLength={lim.names.profile} value={name}
        autoCapitalize="words" autoComplete="off" spellCheck={false} onChange={e => setName(e.target.value)} />
      <button ref={addButton} className="pill go adder-add" data-f="" onClick={save}>Add</button>
    </div>
  )
}

/** Who's watching. Open from the moment it's pushed (marked so here, outside anything that waits), so
 * asks while it's up don't open another; closed when it goes. */
export default function Profiles(props: Parameters<typeof ProfilesScreen>[0]) {
  useEffect(() => {
    whoMounted = true
    profilesInFront = true
    return () => { profilesInFront = false }
  }, [])
  return <ProfilesScreen {...props} />
}
