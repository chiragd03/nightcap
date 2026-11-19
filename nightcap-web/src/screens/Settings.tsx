import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import * as api from '../api'
import { AVATARS, avatarOf, avatarSrc } from '../avatars'
import AdminPin from '../components/AdminPin'
import Icon from '../components/Icon'
import Invites, { Fresh } from '../components/Invites'
import { AddRow, Back, Detail, Mark, Pill, Row, type Status } from '../components/PanelParts'
import Menu, { type Action } from '../components/Menu'
import { useNotice } from '../components/Notice'
import Problem from '../components/Problem'
import { errorWords, isOffline, WORDS } from '../errors'
import { forgetKept } from '../kept'
import { keyLooksRight, priceFields, readPrice, removeBody, saveBody, testBody } from '../aiForm'
import { QUALITIES, ROW_NATIVE, SAMPLE } from '../languages'
import { useSession } from '../session'
import type { Profile } from '../types'
import './Settings.css'
import { useLimitsReady } from '../limits'
import WithLimits from '../components/WithLimits'

// Settings, after the TV's: one composition over a soft glow in the profile's
// colour. A tall profile card (it opens the avatar editor) beside glass cards that show their
// values as pictures: the audio language in its own script, a caption box, a quality badge,
// language chips, the Top 10 number. (The TV's Home corner widgets are set on the TV.) A card opens a glass panel from the right
// with a live preview of the choice under the pointer. Changes save as they're made.
// The admin also has a Household view: profiles, place and time, AI, sources and keys, devices,
// and invites (one device each; the server owner makes them too: see Owner).

type PanelId = 'audio' | 'subtitles' | 'quality' | 'rows' | 'top10'
  | 'profiles' | 'place' | 'ai' | 'sources' | 'devices' | 'invites' | 'livetv'

const HOUSEHOLD: PanelId[] = ['profiles', 'place', 'ai', 'sources', 'devices', 'invites', 'livetv']
// How soft the picture looks at each quality, as on the TV's preview.
const QUALITY_BLUR: Record<string, number> = { best: 0, '4K': 0, '1080p': 0.8, '720p': 2 }
const GLYPHS: Record<string, string> = {
  hin: 'अ आ', jpn: 'あア', kor: '가나', chi: '中文', ara: 'أ ب', rus: 'Аа', tam: 'அ ஆ', tel: 'అ ఆ', pan: 'ਅ ਆ', urd: 'ا ب',
}

function SettingsScreen() {
  const lim = useLimitsReady()
  const session = useSession()
  const location = useLocation()
  const navigate = useNavigate()
  // A panel can be linked to: /settings/profiles (Who's watching's Add and Manage), /settings#sources.
  const linked = (location.pathname.endsWith('/profiles') ? 'profiles' : location.hash.slice(1)) as PanelId
  const start = linked in TITLES ? linked : null
  const [page, setPage] = useState<api.ProfilePage>()
  const [error, setError] = useState<unknown>()
  const [view, setView] = useState<'me' | 'household'>(start && HOUSEHOLD.includes(start) ? 'household' : 'me')
  const [panel, setPanel] = useState<PanelId | null>(start)
  const [editing, setEditing] = useState(false)
  const [confirm, setConfirm] = useState<{ title: string; subtitle?: string; actions: Action[] }>()
  const [notice, notify] = useNotice()

  const reload = useCallback(() => api.profilePage().then(p => { setPage(p); setError(undefined) }, setError), [])
  useEffect(() => { reload() }, [reload])

  // The household's devices and sources (the admin's Household view), each its own route.
  const [house, setHouse] = useState<Household>({})
  const isAdmin = !!page?.isAdmin
  // The Household pages need admin unlocked with the PIN on this device (the server checks it on
  // every admin action); the status says whether there's a PIN yet and whether this tab is unlocked.
  const [adminState, setAdminState] = useState<{ pinSet: boolean; unlocked: boolean }>()
  const checkAdmin = useCallback(() => {
    if (isAdmin) api.adminStatus().then(setAdminState, () => setAdminState({ pinSet: true, unlocked: false }))
  }, [isAdmin])
  useEffect(() => { checkAdmin() }, [checkAdmin])
  const unlocked = !!adminState?.unlocked

  const reloadHouse = useCallback(async () => {
    if (!isAdmin || !unlocked) return
    const [found, sources, livetv] = await Promise.all([api.devicesActivity().catch(() => undefined), api.sources().catch(() => undefined),
      api.liveTv().catch(() => undefined)])
    setHouse({ devices: found?.devices, activityUnavailable: found?.activityUnavailable, sources, livetv, loaded: true })
  }, [isAdmin, unlocked])
  useEffect(() => { reloadHouse() }, [reloadHouse])
  // How many channels Live TV shows (the countries and languages picked applied, the household's own
  // items in), asked again when the lists or what's picked change.
  const [liveShown, setLiveShown] = useState<number>()
  const liveKey = house.livetv ? JSON.stringify([house.livetv.places, house.livetv.lists.map(l => [l.id, l.channels, l.readAt])]) : ''
  useEffect(() => {
    if (!liveKey) return
    let gone = false
    api.livePage().then(p => { if (!gone) setLiveShown(p.shown) }, () => {})
    return () => { gone = true }
  }, [liveKey])
  // The Devices panel follows what's playing: its list is asked for again every 20 seconds while open.
  useEffect(() => {
    if (panel !== 'devices' || !isAdmin || !unlocked) return
    const t = setInterval(() => api.devicesActivity().then(r => setHouse(h => ({ ...h, devices: r.devices, activityUnavailable: r.activityUnavailable })), () => {}), DEVICES_EVERY_MS)
    return () => clearInterval(t)
  }, [panel, isAdmin, unlocked])

  /** A change: saved, said, and everything shown again from the server. */
  const save = async (job: Promise<unknown>, done: string) => {
    try {
      await job
      notify(done)
      await Promise.all([reload(), reloadHouse()])
      session.reload()
    } catch (e) {
      if (e instanceof api.AdminLocked) {
        // The admin session ended while the page was open: ask for the PIN again.
        setPanel(null)
        setAdminState({ pinSet: !e.pinUnset, unlocked: false })
        notify('Admin locked again: type the PIN to carry on')
      } else notify(errorWords(e))
    }
  }

  /** The household's AI saved: the answer (all its sources) shown at once, without asking for
   * everything again (a failed reload would take the form away). Null when saved, else why not (the
   * server's words), so the form stays open with what was typed. */
  const saveAi = async (job: Promise<api.Sources>, done: string): Promise<string | null> => {
    try {
      const sources = await job
      setHouse(h => ({ ...h, sources }))
      notify(done)
      reload()
      return null
    } catch (e) {
      if (e instanceof api.AdminLocked) {
        setPanel(null)
        setAdminState({ pinSet: !e.pinUnset, unlocked: false })
        notify('Admin locked again: type the PIN to carry on')
        return null
      }
      return errorWords(e)
    }
  }

  /** A Live TV change: the answer redraws the panel. Null when it went through (or admin locked again,
   * said); else why not, as the server says it (it never holds a list's address). */
  const live = async (job: Promise<api.LiveTvSettings>, done?: string): Promise<string | null> => {
    try {
      const livetv = await job
      setHouse(h => ({ ...h, livetv }))
      if (done) notify(done)
      return null
    } catch (e) {
      if (e instanceof api.AdminLocked) {
        setPanel(null)
        setAdminState({ pinSet: !e.pinUnset, unlocked: false })
        notify('Admin locked again: type the PIN to carry on')
        return null
      }
      // (The server's own words, kept: they say what's wrong with a list. Not the browser's.)
      return isOffline(e) ? WORDS.offline : (e as Error).message
    }
  }

  if (error && !page) return <Problem words={errorWords(error)} retry={() => { setError(undefined); reload() }} back autoRetry />
  if (!page) return <SettingsSkeleton />

  const s = page.settings
  const a = avatarOf(page.avatar, page.id)
  const audio = lim.audioLanguages.find(l => l.name === (s.audio_language ?? 'English')) ?? lim.audioLanguages[0]
  const subs = s.subtitles && s.subtitles !== 'off' ? lim.audioLanguages.find(l => l.code === s.subtitles) : undefined
  const quality = QUALITIES.find(q => q.key === (s.quality ?? 'best')) ?? QUALITIES[0]
  const countryName = (code?: string) => (page.options.countries.find(c => c.code === code)?.name ?? code ?? '').replace(/^the /, '').replace(/^./, c => c.toUpperCase())
  const acc = page.account
  const admin = page.isAdmin && !!acc

  return (
    <div className="st" style={{ '--glow': glowOf(a.tint) } as CSSProperties}>
      <div className="st-aura" aria-hidden />
      <div className="st-top">
        <span className="eyebrow st-eyebrow">Settings</span>
        <div className="st-top-right">
        {admin && (
          <div className="st-tabs" role="tablist">
            <button role="tab" aria-selected={view === 'me'} className={view === 'me' ? 'on' : ''} onClick={() => setView('me')}>{page.name}</button>
            <button role="tab" aria-selected={view === 'household'} className={view === 'household' ? 'on' : ''} onClick={() => setView('household')}>Household</button>
            {view === 'household' && unlocked && (
              <button className="st-lock" title="Lock admin on this device" onClick={() => api.adminLock().then(() => setAdminState(s => s && { ...s, unlocked: false }))}>Lock</button>
            )}
          </div>
        )}
        {/* Licences and credits, small in the top corner (as the Android TV's). */}
        <Link className="st-licences" to="/licences">Licences and credits</Link>
        <Link className="st-server" to="/server" title="Server owner" aria-label="Server owner"><Icon name="nav_home" size={16} /><span>Server owner</span></Link>
        </div>
      </div>

      {view === 'me' ? (
        <div className="st-stage" key="me">
          <button className="st-card st-profile" onClick={() => setEditing(true)}>
            <span className="st-disc" style={{ '--tint': a.tint } as CSSProperties}><img src={avatarSrc(a.image)} alt="" /></span>
            <span className="st-profile-name">{page.name}</span>
            <span className="eyebrow">{page.isAdmin ? 'Admin profile' : 'Profile'}</span>
            <span className="st-profile-hint">Change avatar or name</span>
          </button>

          <div className="st-grid">
            <Card label="Audio" onClick={() => setPanel('audio')}>
              <span className="st-big">{audio.native}</span>
              <span className="st-small">{audio.name} versions first</span>
            </Card>
            <Card label="Subtitles" onClick={() => setPanel('subtitles')}>
              <span className={`st-caption${subs ? '' : ' off'}`}>{subs ? GLYPHS[subs.code] ?? 'Aa' : 'Off'}</span>
              <span className="st-small">{subs ? subs.name : 'No subtitles'}</span>
            </Card>
            <Card label="Quality" tag={quality.key === 'best' || quality.key === '4K' ? 'UHD' : 'HD'} onClick={() => setPanel('quality')}>
              <span className="st-huge">{quality.title}</span>
              <span className="st-small">{quality.short}</span>
            </Card>
            <Card label="Language rows" wide onClick={() => setPanel('rows')}>
              <span className="st-chips">
                {s.languages.slice(0, 8).map(c => <span key={c} className="st-chip">{ROW_NATIVE[c] ?? c}</span>)}
              </span>
              <span className="st-small">{s.languages.length === 0 ? 'None: Home sticks to English' : `${s.languages.length} ${s.languages.length === 1 ? 'row' : 'rows'}`}</span>
            </Card>
            <Card label="Top 10" onClick={() => setPanel('top10')}>
              <span className="st-ten" aria-hidden>10</span>
              <span className="st-big">{countryName(s.top10_countries[0])}</span>
            </Card>
            {page.usage && (
              <Card label="AI this month" short onClick={() => { setView('household'); setPanel('ai') }}>
                <span className="st-big">{cost(page.usage.month_cost, page.usage.month_unpriced_calls)}</span>
                <span className="st-small">{page.usage.month_calls} {page.usage.month_calls === 1 ? 'request' : 'requests'} · {cost(page.usage.today_cost, page.usage.today_unpriced_calls)} today</span>
              </Card>
            )}
          </div>
        </div>
      ) : acc && !unlocked ? (
        <div className="st-stage" key="pin">
          {adminState && <AdminPin pinSet={adminState.pinSet} name={page.name} onUnlocked={() => setAdminState({ pinSet: true, unlocked: true })} />}
        </div>
      ) : acc && (
        <div className="st-stage" key="household">
          <div className="st-grid household">
            {/* (Seven cards, three to a row: Profiles and Live TV are two wide, so every row is full.) */}
            <Card label="Profiles" wide onClick={() => setPanel('profiles')}>
              <span className="st-faces">
                {session.all.map(p => {
                  const pa = avatarOf(p.avatar, p.id)
                  return <span key={p.id} className="st-face" style={{ '--tint': pa.tint } as CSSProperties}><img src={avatarSrc(pa.image)} alt="" /></span>
                })}
                {/* (On a phone the card fits three: the rest are counted.) */}
                {session.all.length > PHONE_FACES && <span className="st-face st-more phone">+{session.all.length - PHONE_FACES}</span>}
              </span>
              <span className="st-small">{session.all.length} of {lim.maxProfiles} · add, change or remove</span>
            </Card>
            <Card label="Place and time" onClick={() => setPanel('place')}>
              <span className="st-big">{acc.location?.city || countryName(acc.country) || 'Not set'}</span>
              <span className="st-small">{acc.timezone?.replace(/_/g, ' ') ?? 'Time zone not set'}</span>
            </Card>
            <Card label="AI" onClick={() => setPanel(aiBlocked(house.sources?.ai) ? 'sources' : 'ai')}>
              <span className="st-huge">{page.usage ? cost(page.usage.month_cost, page.usage.month_unpriced_calls) : '—'}</span>
              {acc.aiLimit != null && page.usage && page.usage.priced !== false && <span className="st-meter"><span style={{ width: `${Math.min(100, page.usage.month_cost / Math.max(acc.aiLimit, 0.01) * 100)}%` }} /></span>}
              <span className="st-small">{aiBlocked(house.sources?.ai)
                ?? (house.sources?.ai?.model && !house.sources.ai.price ? "this month · price unknown: spending isn't counted"
                  : acc.aiLimit != null ? `this month, of ${money(acc.aiLimit)}` : 'this month · no limit')}</span>
            </Card>
            <Card label="Sources and keys" onClick={() => setPanel('sources')}>
              <SourcesSummary sources={house.sources} />
            </Card>
            <Card label="Devices" onClick={() => setPanel('devices')}>
              <span className="st-kinds">
                {(house.devices ?? []).map(d => <span key={d.id} className={`st-kind ${api.deviceKind(d)}`}>{api.deviceKind(d) === 'tv' ? 'TV' : 'Web'}</span>)}
                {/* (One row: the rest are counted, so the line under them always shows.) */}
                {(house.devices?.length ?? 0) > WIDE_KINDS && <span className="st-kind st-more wide">+{house.devices!.length - WIDE_KINDS}</span>}
                {(house.devices?.length ?? 0) > PHONE_KINDS && <span className="st-kind st-more phone">+{house.devices!.length - PHONE_KINDS}</span>}
              </span>
              {(() => {
                const live = (house.devices ?? []).filter(d => d.activity?.watching || d.activity?.paused)
                if (live.length) return <span className="st-small st-live"><i aria-hidden /><span>{live.length === 1 ? `${live[0].name}: ${live[0].activity!.title}` : `${live.length} watching now`}</span></span>
                return <span className="st-small">{house.devices ? `${house.devices.length} ${house.devices.length === 1 ? 'device' : 'devices'} · rename or remove` : 'TVs and browsers'}</span>
              })()}
            </Card>
            <Card label="Live TV" className="wide-desk" onClick={() => setPanel('livetv')}>
              {house.livetv && house.livetv.lists.length ? (
                <>
                  <span className="st-big">{liveShown != null ? liveShown.toLocaleString() : '…'}</span>
                  <span className="st-small">channels on Live TV · {house.livetv.lists.length} {house.livetv.lists.length === 1 ? 'list' : 'lists'}</span>
                </>
              ) : (
                <>
                  <span className="st-big">Add a list</span>
                  <span className="st-small">Your own channels (M3U)</span>
                </>
              )}
            </Card>
            <Card label="Invites" onClick={() => setPanel('invites')}>
              <span className="st-big">Add a device</span>
              <span className="st-small">One invite per TV or browser</span>
            </Card>
          </div>
        </div>
      )}

      {/* Signing out is in the left panel; here only on phones, where the bottom bar has no room (and
          Licences and credits, which the top has no room for there). */}
      <div className="st-foot phone-only">
        <Link className="st-foot-link" to="/licences">Licences and credits</Link>
        <button className="st-foot-link quit" onClick={() => setConfirm({
          title: 'Sign out of this browser?',
          subtitle: "This browser leaves the household and forgets everything here. To sign in again you'll need a new invite from the household's admin or the server owner.",
          actions: [{ icon: 'act_remove', label: 'Sign out', run: () => { api.signOut().then(() => navigate('/', { replace: true })) } },
                    { icon: 'act_close', label: 'Stay signed in', run: () => {} }],
        })}><Icon name="nav_sign_out" size={16} /> Sign out of this browser</button>
      </div>

      {panel && (!HOUSEHOLD.includes(panel) || unlocked) && <Panel id={panel} page={page} house={house} session={session} onClose={() => setPanel(null)} save={save} setConfirm={setConfirm} reloadHouse={reloadHouse} live={live} saveAi={saveAi} liveShown={liveShown} />}
      {editing && (
        <Editor profile={page} onClose={() => setEditing(false)}
          onSave={(c, done) => save(api.changeProfile({ id: page.id, ...c }), done)} />
      )}
      {confirm && <Menu {...confirm} onClose={() => setConfirm(undefined)} />}
      {notice}
    </div>
  )
}

// ---------- Cards ----------

function Card({ label, tag, onClick, wide, short, soon, className, children }: {
  label: string; tag?: string; onClick: () => void; wide?: boolean; short?: boolean; soon?: boolean; className?: string; children: ReactNode
}) {
  return (
    <button className={`st-card${wide ? ' wide' : ''}${short ? ' short' : ''}${soon ? ' soon' : ''}${className ? ` ${className}` : ''}`} onClick={onClick}>
      <span className="eyebrow st-label">{label}</span>
      {/* (A tag top right, level with the label, the same inset as everything else in the card.) */}
      {tag && <span className="st-badge">{tag}</span>}
      <span className="st-body">{children}</span>
    </button>
  )
}

const money = (usd: number) => (usd >= 0.01 || usd === 0 ? `$${usd.toFixed(2)}` : 'under 1¢')

/** The light a disc casts: its deep colour made brighter and richer (as on the TV). */
function glowOf(tint: string) {
  const n = parseInt(tint.slice(1), 16)
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(x => x / 255)
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min
  const h = d === 0 ? 0 : max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  const sat = Math.min((max === 0 ? 0 : d / max) * 1.35, 0.85), v = 0.78
  const f = (k: number) => { const x = (k + h + 6) % 6; return Math.round((v - v * sat * Math.max(0, Math.min(x, 4 - x, 1))) * 255) }
  return `rgb(${f(5)}, ${f(3)}, ${f(1)})`
}

// ---------- The panel: from the right, a live preview over the choices ----------

const TITLES: Record<PanelId, [string, string]> = {
  audio: ['Audio', 'Versions in this language play first, dubbed ones too.'],
  subtitles: ['Subtitles', 'Turned on when a film or episode starts. Change them any time while watching.'],
  quality: ['Quality', 'The sharpest version up to this goes first.'],
  rows: ['Language rows', 'Each one gets its own Latest shows and movies rows on Home.'],
  top10: ['Top 10', "Which country's Top 10 shows and movies are on Home."],
  profiles: ['Profiles', "Up to six. The admin profile can't be removed."],
  place: ['Place and time', 'For the weather, release dates and “today”.'],
  ai: ['AI', 'What the AI picks and Smart Search have cost.'],
  sources: ['Sources and keys', 'Where your streams come from.'],
  devices: ['Devices', 'Every TV and browser in the household. A removed one has to join again.'],
  invites: ['Invites', 'Each lets one TV or browser join, once, within 24 hours.'],
  livetv: ['Live TV', 'Channels from your own channel lists (M3U), watched on the TVs.'],
}

type Household = { devices?: api.Device[]; sources?: api.Sources; loaded?: boolean; activityUnavailable?: boolean
  livetv?: api.LiveTvSettings }

type PanelProps = {
  id: PanelId
  /** The household's AI saved (the answer shown at once); why not, if it wasn't. */
  saveAi: AiSaver
  page: api.ProfilePage
  house: Household
  /** The household's devices and sources fetched again. */
  reloadHouse: () => void
  /** How many channels Live TV shows (undefined until asked). */
  liveShown?: number
  session: ReturnType<typeof useSession>
  onClose: () => void
  save: (job: Promise<unknown>, done: string) => Promise<void>
  setConfirm: (c: { title: string; subtitle?: string; actions: Action[] } | undefined) => void
  /** A Live TV change (its answer redraws the panel): null, or why it didn't go through. */
  live: LiveSaver
}

function Panel({ id, page, house, session, onClose, save, saveAi, setConfirm, reloadHouse, live, liveShown }: PanelProps) {
  const lim = useLimitsReady()
  const [hover, setHover] = useState<string>()
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])

  const s = page.settings
  const acc = page.account
  const [title, hint] = TITLES[id]
  const audio = s.audio_language ?? 'English'
  const subs = s.subtitles ?? 'off'
  const quality = s.quality ?? 'best'

  let preview: ReactNode = null
  let body: ReactNode = null
  if (id === 'audio') {
    const l = lim.audioLanguages.find(x => x.name === (hover ?? audio))
    preview = <Still src={page.still}><span className="pv-word">{l?.native}</span></Still>
    body = <Choices hover={setHover} chosen={audio}
      items={lim.audioLanguages.map(x => ({ key: x.name, title: x.native, sub: x.native !== x.name ? x.name : undefined }))}
      onPick={k => save(api.saveSettings({ audio_language: k }), `Audio: ${k}`)} />
  } else if (id === 'subtitles') {
    const code = hover ?? subs
    preview = <Still src={page.still}>{code !== 'off' ? <span className="pv-caption">{SAMPLE[code]}</span> : <span className="pv-off">No subtitles</span>}</Still>
    body = <Choices hover={setHover} chosen={subs}
      items={[{ key: 'off', title: 'Off' }, ...lim.audioLanguages.map(x => ({ key: x.code, title: x.native, sub: x.native !== x.name ? x.name : undefined }))]}
      onPick={k => save(api.saveSettings({ subtitles: k }), k === 'off' ? 'Subtitles off' : `Subtitles: ${lim.audioLanguages.find(x => x.code === k)?.name}`)} />
  } else if (id === 'quality') {
    const q = QUALITIES.find(x => x.key === (hover ?? quality)) ?? QUALITIES[0]
    preview = <Still src={page.still} blur={QUALITY_BLUR[q.key]}><span className="pv-badge">{q.title}</span><span className="pv-data">{q.data}</span></Still>
    body = <Choices hover={setHover} chosen={quality}
      items={QUALITIES.map(x => ({ key: x.key, title: x.title, sub: x.detail }))}
      onPick={k => save(api.saveSettings({ quality: k }), `Quality: ${QUALITIES.find(x => x.key === k)?.title}`)} />
  } else if (id === 'rows') {
    const code = hover ?? s.languages[0] ?? page.options.languages[0]?.code
    preview = <Posters keyName={code && `lang:${code}`} />
    body = (
      <div className="pn-items">
        {page.options.languages.map(o => {
          const on = s.languages.includes(o.code)
          return (
            <Item key={o.code} title={ROW_NATIVE[o.code] ?? o.name} sub={ROW_NATIVE[o.code] && ROW_NATIVE[o.code] !== o.name ? o.name : undefined}
              on={on} check onHover={() => setHover(o.code)}
              onClick={() => save(api.saveSettings({ languages: on ? s.languages.filter(c => c !== o.code) : [...s.languages, o.code] }),
                on ? `${o.name} row off` : `${o.name} row on`)} />
          )
        })}
      </div>
    )
  } else if (id === 'top10') {
    const code = hover ?? s.top10_countries[0]
    preview = <Posters keyName={code && `top10:${code}`} ranked />
    body = <Choices hover={setHover} chosen={s.top10_countries[0]}
      items={page.options.countries.map(c => ({ key: c.code, title: `Top 10 in ${c.name}` }))}
      onPick={k => save(api.saveSettings({ top10_countries: [k, ...s.top10_countries.filter(c => c !== k)] }), 'Top 10 changed')} />
  } else if (id === 'profiles') {
    body = <ProfilesAdmin all={session.all} meId={page.id}
      onSave={(pid, c, done) => save(api.changeProfile({ id: pid, ...c }), done)}
      onAdd={(name, avatar) => save(api.addProfile(name, avatar), `${name} added`)}
      onRemove={p => setConfirm({
        title: `Remove ${p.name}?`, subtitle: 'Their history, ratings and picks go too.',
        actions: [{ icon: 'act_remove', label: `Remove ${p.name}`, run: () => save(api.removeProfile(p.id).then(r => { forgetKept(p.id); return r }), `${p.name} removed`) },
                  { icon: 'act_close', label: 'Keep', run: () => {} }],
      })} />
  } else if (id === 'place' && acc) {
    body = <Place household={acc} onSave={(c, done) => save(api.saveHousehold(c), done)} />
  } else if (id === 'ai' && acc) {
    body = <Ai usage={page.usage} limit={acc.aiLimit} problem={aiBlocked(house.sources?.ai)} onLimit={usd => save(api.saveAiLimit(usd), usd == null ? 'No monthly limit' : `Monthly limit: ${money(usd)}`)} />
  } else if (id === 'sources') {
    body = house.sources ? <SourcesPanel sources={house.sources} save={save} saveAi={saveAi} setConfirm={setConfirm} onRefresh={reloadHouse} /> : <Waiting loaded={house.loaded} />
  } else if (id === 'devices') {
    body = house.devices ? (
      <DevicesPanel devices={house.devices} activityUnavailable={house.activityUnavailable}
        onCode={d => { const job = api.deviceCode(d.id); save(job, `Sign-in code made for ${d.name}`).catch(() => {}); return job }} onRename={(d, name) => save(api.renameDevice(d.id, name), `Renamed to ${name}`)} onRemove={d => setConfirm({
        title: `Remove ${d.name}?`,
        subtitle: d.thisDevice ? 'This browser: it will have to join the household again.' : 'It stops working at once, until it joins again.',
        actions: [{ icon: 'act_remove', label: `Remove ${d.name}`, run: () => save(api.removeDevice(d.id), `${d.name} removed`) },
                  { icon: 'act_close', label: 'Keep', run: () => {} }],
      })} />
    ) : <Waiting loaded={house.loaded} />
  } else if (id === 'invites') {
    body = <div className="pn-items"><Invites maker={api.adminInvites} save={save} /></div>
  } else if (id === 'livetv') {
    body = house.livetv ? <LiveTvPanel data={house.livetv} shown={liveShown} live={live} setConfirm={setConfirm} /> : <Waiting loaded={house.loaded} />
  }

  return (
    <div className="pn-scrim" onClick={onClose}>
      <aside className="pn" onClick={e => e.stopPropagation()} role="dialog" aria-label={title} onMouseLeave={() => setHover(undefined)}>
        <button className="pn-close" aria-label="Close" onClick={onClose}><Icon name="act_close" size={18} /></button>
        <h3>{title}</h3>
        <p className="pn-hint">{hint}</p>
        {preview && <div className="pn-preview">{preview}</div>}
        <div className="pn-scroll">{body}</div>
      </aside>
    </div>
  )
}

/** One choice in a panel: a tick when chosen, the label, a grey detail line. */
function Item({ title, sub, on, check, toggle, onClick, onHover }: {
  title: string; sub?: string; on?: boolean; check?: boolean; toggle?: boolean; onClick: () => void; onHover?: () => void
}) {
  return (
    <button className={`pn-item${on ? ' on' : ''}`} onClick={onClick} onMouseEnter={onHover} onFocus={onHover}
      role={toggle || check ? 'switch' : undefined} aria-checked={toggle || check ? on : undefined}>
      {!toggle && <span className="pn-tick">{on ? <Icon name="check" size={14} /> : null}</span>}
      <span className="pn-label"><b>{title}</b>{sub && <small>{sub}</small>}</span>
      {toggle && <span className={`switch${on ? ' on' : ''}`} />}
    </button>
  )
}

function Choices({ items, chosen, onPick, hover }: {
  items: { key: string; title: string; sub?: string }[]; chosen?: string; onPick: (key: string) => void; hover: (key?: string) => void
}) {
  return (
    <div className="pn-items">
      {items.map(i => <Item key={i.key} title={i.title} sub={i.sub} on={i.key === chosen} onHover={() => hover(i.key)}
        onClick={() => i.key !== chosen && onPick(i.key)} />)}
    </div>
  )
}

function Still({ src, blur = 0, children }: { src?: string | null; blur?: number; children: ReactNode }) {
  return (
    <div className="pv-still">
      {src && <img src={src} alt="" style={{ filter: blur ? `blur(${blur * 1.6}px)` : undefined, transform: blur ? 'scale(1.04)' : undefined }} />}
      <div className="pv-over">{children}</div>
    </div>
  )
}

/** A setting's posters (a language row's titles, a country's Top 10), fetched once each. */
const posterCache = new Map<string, Promise<string[]>>()
function Posters({ keyName, ranked }: { keyName?: string; ranked?: boolean }) {
  const [list, setList] = useState<string[]>([])
  const shown = useRef(keyName)
  useEffect(() => {
    shown.current = keyName
    if (!keyName) return setList([])
    if (!posterCache.has(keyName)) posterCache.set(keyName, api.settingPreview(keyName).then(r => r.posters, () => []))
    posterCache.get(keyName)!.then(p => { if (shown.current === keyName) setList(p) })
  }, [keyName])
  return (
    <div className="pv-posters">
      {list.slice(0, 6).map((p, i) => (
        <span key={p} className="pv-poster" style={{ '--i': i } as CSSProperties}>
          {ranked && <b>{i + 1}</b>}
          <img src={p} alt="" />
        </span>
      ))}
    </div>
  )
}

// ---------- The avatar editor: avatars in a sliding line, the name under them ----------

type Change = { name?: string; avatar?: string }

function Editor({ profile: p, onSave, onClose }: { profile: Profile; onSave: (c: Change, done: string) => void; onClose: () => void }) {
  const lim = useLimitsReady()
  const [pick, setPick] = useState(avatarOf(p.avatar, p.id).key)
  const [name, setName] = useState(p.name)
  const strip = useRef<HTMLDivElement>(null)
  const a = AVATARS.find(x => x.key === pick)!
  const trimmed = name.trim().replace(/\s+/g, ' ')
  const finish = () => {
    if (pick !== avatarOf(p.avatar, p.id).key) onSave({ avatar: pick }, 'Avatar changed')
    if (trimmed && trimmed !== p.name) onSave({ name: trimmed }, `Name: ${trimmed}`)
    onClose()
  }
  useEffect(() => {
    strip.current?.querySelector('.on')?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' })
  }, [pick])
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])
  return (
    <div className="ed" style={{ '--glow': glowOf(a.tint) } as CSSProperties}>
      <div className="st-aura" aria-hidden />
      <span className="eyebrow ed-eyebrow">Choose your avatar</span>
      <div className="ed-strip" ref={strip}>
        {AVATARS.map(x => (
          <button key={x.key} className={`ed-avatar${x.key === pick ? ' on' : ''}`} style={{ '--tint': x.tint } as CSSProperties}
            aria-label={x.key.replace('_', ' ')} onClick={() => setPick(x.key)}>
            <img src={avatarSrc(x.image)} alt="" />
          </button>
        ))}
      </div>
      <form className="ed-form" onSubmit={e => { e.preventDefault(); finish() }}>
        <input className="ed-name" value={name} maxLength={lim.names.profile} onChange={e => setName(e.target.value)} aria-label="Name" spellCheck={false} />
        <span className="ed-hint">Type to change the name</span>
        <div className="ed-buttons">
          <button className="btn primary" disabled={!trimmed}>Done</button>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </div>
  )
}

// ---------- Household panels ----------

function ProfilesAdmin({ all, meId, onSave, onAdd, onRemove }: {
  all: Profile[]; meId: string
  onSave: (id: string, c: Change, done: string) => void
  onAdd: (name: string, avatar: string) => void
  onRemove: (p: Profile) => void
}) {
  const lim = useLimitsReady()
  const [open, setOpen] = useState<string | null>(null)
  const [name, setName] = useState('')
  // A new profile starts on an avatar nobody has yet (as on the TV).
  const free = AVATARS.find(x => !all.some(p => avatarOf(p.avatar, p.id).key === x.key))?.key ?? AVATARS[0].key
  const [avatar, setAvatar] = useState(free)
  const target = all.find(p => p.id === open)

  if (open === 'new' || target) {
    const isNew = open === 'new'
    const current = isNew ? '' : target!.name
    const typed = name || current
    const clean = typed.trim().replace(/\s+/g, ' ')
    const shownAvatar = isNew ? avatar : avatarOf(target!.avatar, target!.id).key
    return (
      <div className="pn-items">
        <Back onClick={() => { setOpen(null); setName('') }} title={isNew ? 'New profile' : current}>Profiles</Back>
        <form className="pn-field" onSubmit={e => {
          e.preventDefault()
          if (!clean) return
          if (isNew) { onAdd(clean, avatar); setOpen(null); setName('') }
          else if (clean !== current) onSave(target!.id, { name: clean }, `Name: ${clean}`)
        }}>
          <input value={typed} maxLength={lim.names.profile} placeholder="Name" autoFocus onChange={e => setName(e.target.value)} aria-label="Name" />
          <button className="btn primary" disabled={!clean || clean === current}>{isNew ? 'Add' : 'Save'}</button>
        </form>
        <div className="pn-avatars">
          {AVATARS.map(x => (
            <button key={x.key} className={`pn-avatar${x.key === shownAvatar ? ' on' : ''}`} style={{ '--tint': x.tint } as CSSProperties}
              aria-label={x.key.replace('_', ' ')}
              onClick={() => (isNew ? setAvatar(x.key) : onSave(target!.id, { avatar: x.key }, 'Avatar changed'))}>
              <img src={avatarSrc(x.image)} alt="" />
            </button>
          ))}
        </div>
        {target && !target.isAdmin && (
          <button className="btn danger" onClick={() => { onRemove(target); setOpen(null) }}>Remove {target.name}</button>
        )}
      </div>
    )
  }
  return (
    <div className="pn-items">
      {all.map(p => {
        const pa = avatarOf(p.avatar, p.id)
        return (
          <button key={p.id} className="pn-item person" onClick={() => { setName(''); setOpen(p.id) }}>
            <span className="st-face" style={{ '--tint': pa.tint } as CSSProperties}><img src={avatarSrc(pa.image)} alt="" /></span>
            <span className="pn-label"><b>{p.name}</b><small>{p.isAdmin ? 'Admin' : p.id === meId ? 'You' : 'Profile'}</small></span>
            <Icon name="chevron" size={14} />
          </button>
        )
      })}
      {all.length < lim.maxProfiles && (
        <button className="pn-item person" onClick={() => { setName(''); setOpen('new') }}>
          <span className="st-face add"><Icon name="add" size={18} /></span>
          <span className="pn-label"><b>Add profile</b><small>{lim.maxProfiles - all.length} more can be added</small></span>
        </button>
      )}
    </div>
  )
}

/** Every time zone the browser knows, and every country it has a name for. */
const ZONES: string[] = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? []
const REGION = new Intl.DisplayNames(undefined, { type: 'region' })
const ALL_COUNTRIES = (() => {
  const out: { code: string; name: string }[] = []
  for (let i = 65; i <= 90; i++) for (let j = 65; j <= 90; j++) {
    const code = String.fromCharCode(i, j)
    const name = REGION.of(code)
    if (name && name !== code && !/unknown/i.test(name)) out.push({ code, name })
  }
  return out.sort((x, y) => x.name.localeCompare(y.name))
})()

type FoundPlace = { name: string; admin1?: string; country_code: string; latitude: number; longitude: number; timezone?: string }

function Place({ household: h, onSave }: { household: api.HouseholdSettings; onSave: (c: Record<string, unknown>, done: string) => void }) {
  const [q, setQ] = useState('')
  const [found, setFound] = useState<FoundPlace[]>([])
  // Places from Open-Meteo's free geocoding (no key); the weather comes from Open-Meteo too.
  useEffect(() => {
    if (q.trim().length < 2) return setFound([])
    const t = setTimeout(() => fetch(`https://geocoding-api.open-meteo.com/v1/search?count=6&name=${encodeURIComponent(q.trim())}`)
      .then(r => r.json()).then(d => setFound(d.results ?? []), () => setFound([])), 300)
    return () => clearTimeout(t)
  }, [q])
  const pick = (p: FoundPlace) => {
    setQ(''); setFound([])
    onSave({ location: { lat: p.latitude, lon: p.longitude, city: p.name, countryCode: p.country_code },
      country: p.country_code, ...(p.timezone ? { timezone: p.timezone } : {}) }, `Place: ${p.name}`)
  }
  return (
    <div className="pn-items">
      <h4 className="pn-sub">City</h4>
      <p className="pn-current">{h.location ? `${h.location.city}, ${REGION.of(h.location.countryCode) ?? h.location.countryCode}` : 'Not set: the TV shows no weather'}</p>
      <input className="pn-input" value={q} placeholder="Search for your city" onChange={e => setQ(e.target.value)} aria-label="City" />
      {found.map(p => (
        <Item key={`${p.latitude},${p.longitude}`} title={p.name} sub={[p.admin1, REGION.of(p.country_code)].filter(Boolean).join(', ')} onClick={() => pick(p)} />
      ))}
      <p className="pn-note">Picking a city also sets the country and time zone.</p>
      <h4 className="pn-sub">Country</h4>
      <select className="pn-input" value={h.country ?? ''} onChange={e => onSave({ country: e.target.value }, `Country: ${REGION.of(e.target.value)}`)}>
        {!h.country && <option value="">Not set</option>}
        {ALL_COUNTRIES.map(c => <option key={c.code} value={c.code}>{c.name}</option>)}
      </select>
      <h4 className="pn-sub">Time zone</h4>
      <select className="pn-input" value={h.timezone ?? ''} onChange={e => onSave({ timezone: e.target.value }, `Time zone: ${e.target.value.replace(/_/g, ' ')}`)}>
        {!h.timezone && <option value="">Not set</option>}
        {ZONES.map(z => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}
      </select>
    </div>
  )
}

function Ai({ usage, limit, problem, onLimit }: { usage?: api.Usage | null; limit?: number | null; problem?: string | null; onLimit: (usd: number | null) => void }) {
  const lim = useLimitsReady()
  const [value, setValue] = useState(limit != null ? String(limit) : '')
  useEffect(() => setValue(limit != null ? String(limit) : ''), [limit])
  const max = Math.max(0.0001, ...(usage?.daily ?? []).map(d => d.cost))
  const typed = value.trim() === '' ? null : Number(value)
  const valid = typed === null || (Number.isFinite(typed) && typed >= 0 && typed <= lim.monthlyLimitMaxUsd)
  return (
    <div className="pn-items">
      {problem && <p className="pn-note warn">{problem}. It's set in Sources and keys.</p>}
      {usage && (
        <>
          <div className="pn-money">
            <b>{cost(usage.month_cost, usage.month_unpriced_calls)}</b>
            <span>this month · {usage.month_calls} requests · {cost(usage.today_cost, usage.today_unpriced_calls)} today</span>
          </div>
          {usage.priced === false && <p className="pn-note">This model's price isn't known: its spending isn't counted, and the monthly limit doesn't apply to it.</p>}
          {limit != null && usage.priced !== false && <div className={`st-meter big${usage.limitReached ? ' full' : ''}`}><span style={{ width: `${Math.min(100, usage.month_cost / Math.max(limit, 0.01) * 100)}%` }} /></div>}
          {usage.limitReached && <p className="pn-note warn">The limit is reached: AI picks and Smart Search wait until next month.</p>}
          <h4 className="pn-sub">Last 30 days</h4>
          <div className="pn-days" role="img" aria-label="AI cost each day">
            {usage.daily.map(d => <span key={d.date} title={`${d.date}: ${d.unpriced ? (d.cost ? `$${d.cost.toFixed(3)}+` : 'cost unknown') : `$${d.cost.toFixed(3)}`}, ${d.calls} requests`} style={{ height: `${Math.max(3, d.cost / max * 100)}%` }} />)}
          </div>
          {usage.by_profile.length > 0 && <h4 className="pn-sub">By profile, this month</h4>}
          {usage.by_profile.map(p => (
            <div key={p.name} className="pn-item static"><span className="pn-label"><b>{p.name}</b><small>{p.calls} requests</small></span><b>{cost(p.cost, p.unpriced)}</b></div>
          ))}
        </>
      )}
      <h4 className="pn-sub">Monthly limit</h4>
      <form className="pn-field" onSubmit={e => { e.preventDefault(); if (valid) onLimit(typed) }}>
        <span className="pn-money-input">$<input value={value} inputMode="decimal" placeholder="No limit" onChange={e => setValue(e.target.value)} aria-label="Monthly limit in dollars" /></span>
        <button className="btn primary" disabled={!valid || typed === (limit ?? null)}>Save</button>
      </form>
      <p className="pn-note">Empty means no limit. Once it's reached the AI waits until next month; everything else keeps working.</p>
    </div>
  )
}

/** An AI total: the money, or "$0.42+" / "Cost unknown" when [unpriced] calls were to a model without
 * a price (their cost isn't in it), as the Android TV says it. */
function cost(usd: number, unpriced = 0) {
  if (!unpriced) return money(usd)
  return usd === 0 ? 'Cost unknown' : `${money(usd)}+`
}

/** What the household's AI is missing, in the order it's asked for: the key again (saved without its
 * provider), a model; or that its price isn't known (it works, spending isn't counted). */
function aiProblem(ai: api.Sources['ai'] | undefined) {
  if (!ai) return null
  if (!ai.provider) return 'Add the key again: no AI until then'
  if (!ai.model) return 'Choose a model: no AI until then'
  if (!ai.price) return "Price unknown: spending isn't counted"
  return null
}

/** Why the household's AI can't be used now (not just unpriced: that one works), or null. */
function aiBlocked(ai: api.Sources['ai'] | undefined) {
  const problem = aiProblem(ai)
  return problem && !problem.startsWith('Price') ? problem : null
}

/** A household panel whose data hasn't come (yet, or at all). */
const Waiting = ({ loaded }: { loaded?: boolean }) =>
  <p className="pn-current">{loaded ? "Couldn't load this from the server. Close and open it again to retry." : 'Loading…'}</p>

// ---------- Devices ----------


/** "just now", "5 minutes ago", "yesterday", "3 Oct". */
function ago(iso: string | null) {
  if (!iso) return 'never'
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 90) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} minutes ago`
  if (s < 86400) return `${Math.round(s / 3600)} hours ago`
  if (s < 2 * 86400) return 'yesterday'
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

function DevicesPanel({ devices, activityUnavailable, onRename, onRemove, onCode }: {
  devices: api.Device[]; activityUnavailable?: boolean; onRename: (d: api.Device, name: string) => Promise<void>; onRemove: (d: api.Device) => void
  /** Makes the device's own sign-in code (shown this once). */
  onCode: (d: api.Device) => Promise<api.NewInvite>
}) {
  const [open, setOpen] = useState<string>()
  const [code, setCode] = useState<api.NewInvite>()
  const [renaming, setRenaming] = useState(false)
  const old = api.leftovers(devices)
  const d = devices.find(x => x.id === open)
  if (d && renaming) {
    return (
      <div className="pn-items">
        <Back onClick={() => setRenaming(false)}>{d.name}</Back>
        <DeviceName current={d.name} onSave={name => onRename(d, name).then(() => setRenaming(false))} />
      </div>
    )
  }
  if (d) {
    return (
      <div className="pn-items">
        <Back onClick={() => setOpen(undefined)}>Devices</Back>
        {d.activity && <NowCard device={d} activity={d.activity} />}
        <Detail mark={<DeviceMark device={d} big />} name={d.name}
          lines={[api.deviceKind(d) === 'tv' ? 'TV' : 'Browser', d.lastUsed ? `Used ${ago(d.lastUsed)}` : 'Not used since it joined',
            `Joined ${new Date(d.joined).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`]}
          badge={d.thisDevice ? 'This browser' : old.has(d.id) ? 'Left over' : undefined} />
        {old.has(d.id) && <p className="pn-note top">This {api.deviceKind(d) === 'tv' ? 'TV' : 'browser'} joined again later, so this older entry isn't used any more. It's safe to remove.</p>}
        <Pill icon="act_rate" sub="So you can tell it apart: “Living room TV”" onClick={() => setRenaming(true)}>Rename</Pill>
        {code?.for?.id === d.id && <Fresh invite={code} tv={api.deviceKind(d) === 'tv'} onDone={() => setCode(undefined)} />}
        {!d.thisDevice && code?.for?.id !== d.id && (
          <Pill icon="add" sub="If this device was signed out (its data cleared), enter this code on it to sign it back in as itself"
            onClick={() => onCode(d).then(setCode, () => {})}>Sign-in code</Pill>
        )}
        <Pill icon="act_remove" danger onClick={() => { onRemove(d); setOpen(undefined) }}>Remove this device</Pill>
      </div>
    )
  }
  const live = devices.filter(x => x.activity?.watching || x.activity?.paused)
  return (
    <div className="pn-items">
      {activityUnavailable && <p className="pn-note top">Couldn't load what the devices are playing right now. It's tried again in a moment.</p>}
      {live.length > 0 && (
        <>
          <h4 className="pn-sub">Watching now</h4>
          <div className="dv-now-list">
            {live.map(x => <NowCard key={x.id} device={x} activity={x.activity!} onClick={() => setOpen(x.id)} compact />)}
          </div>
          <h4 className="pn-sub">All devices</h4>
        </>
      )}
      {devices.map(x => (
        <Row key={x.id} mark={<DeviceMark device={x} />} name={x.name} badge={x.thisDevice ? 'This browser' : old.has(x.id) ? 'Left over' : undefined}
          sub={old.has(x.id) ? 'An older entry: it joined again since. Safe to remove' : deviceLine(x)}
          onClick={() => setOpen(x.id)} />
      ))}
    </div>
  )
}

const DEVICES_EVERY_MS = 20_000
// How many profile faces and device chips the Household cards show before counting the rest.
const PHONE_FACES = 3
const WIDE_KINDS = 4
const PHONE_KINDS = 2

/** A device's second line: watching now, else what it watched last (and how far), else when it was used. */
function deviceLine(d: api.Device) {
  const a = d.activity
  if (a?.watching) return `Watching now · ${a.profile.name}`
  if (a?.paused) return `Paused · ${playName(a)} · ${a.profile.name}`
  if (a) return `Last: ${[playName(a), a.finished ? 'finished' : percent(a)].filter(Boolean).join(' · ')} · ${ago(a.at)}`
  return d.lastUsed ? `Used ${ago(d.lastUsed)}` : 'Not used since it joined'
}

const playName = (a: api.Activity) => [a.title, a.episode].filter(Boolean).join(' ')
const percent = (a: api.Activity) => (a.duration ? `${Math.min(100, Math.round((a.position / a.duration) * 100))}%` : '')
const minutes = (ms: number) => Math.max(0, Math.round(ms / 60_000))

/** "Started 3:40 PM" (or "yesterday, 9:10 PM"); "Paused 6 min" since its position last moved. */
function when(a: api.Activity) {
  const started = new Date(a.started ?? a.at)
  const today = new Date().toDateString() === started.toDateString()
  const time = started.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  const day = today ? '' : `${started.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}, `
  return `Started ${day}${time}`
}
function pausedFor(a: api.Activity) {
  const m = Math.max(1, Math.round((Date.now() - new Date(a.movedAt ?? a.at).getTime()) / 60_000))
  return m < 60 ? `${m} min` : `${Math.round(m / 60)} h`
}

/** What a device is playing (or played last): its picture, the title, how far, who, and since when.
 * [compact]: the list's row (a small picture beside it); else the device's own page (a picture card). */
function NowCard({ device, activity: a, onClick, compact }: { device: api.Device; activity: api.Activity; onClick?: () => void; compact?: boolean }) {
  const [broken, setBroken] = useState(false)
  const pic = !broken && (a.picture || a.poster)
  const face = avatarOf(a.profile.avatar, a.profile.id)
  const done = a.duration ? Math.min(1, a.position / a.duration) : 0
  const state = a.watching ? <><i aria-hidden />Live</> : a.paused ? `Paused · ${pausedFor(a)}` : a.finished ? 'Finished' : 'Last watched'
  const progress = a.duration ? `${minutes(a.position)} of ${minutes(a.duration)} min` : ''
  const Tag = onClick ? 'button' : 'div'
  const cls = `dv-now${compact ? ' compact' : ''}${a.watching ? ' live' : a.paused ? ' paused' : ''}${onClick ? '' : ' static'}`
  if (compact) {
    return (
      <Tag className={cls} onClick={onClick}>
        <span className="dv-thumb">
          {pic && <img src={pic} alt="" loading="lazy" onError={() => setBroken(true)} />}
          <span className="dv-bar" aria-hidden><i style={{ width: `${done * 100}%` }} /></span>
        </span>
        <span className="dv-body">
          <span className="dv-state">{state}</span>
          <b className="dv-title">{a.title}{a.episode && <small> {a.episode}</small>}</b>
          <span className="dv-meta">
            <span className="dv-face small" style={{ '--tint': face.tint } as CSSProperties}><img src={avatarSrc(face.image)} alt="" /></span>
            <span>{a.profile.name} · {device.name}</span>
          </span>
          <span className="dv-meta muted">{[when(a), progress].filter(Boolean).join('  ·  ')}</span>
        </span>
      </Tag>
    )
  }
  return (
    <Tag className={cls} onClick={onClick}>
      <span className="dv-pic">
        {pic && <img src={pic} alt="" loading="lazy" onError={() => setBroken(true)} />}
        <span className="dv-chip">{state}</span>
        <span className="dv-text">
          <b>{a.title}</b>
          {(a.episode || a.episodeName) && <small>{[a.episode, a.episodeName].filter(Boolean).join('  ·  ')}</small>}
        </span>
        <span className="dv-bar" aria-hidden><i style={{ width: `${done * 100}%` }} /></span>
      </span>
      <span className="dv-foot">
        <span className="dv-face" style={{ '--tint': face.tint } as CSSProperties}><img src={avatarSrc(face.image)} alt="" /></span>
        <span className="dv-who"><b>{a.profile.name}</b><small>{a.watching || a.paused ? when(a) : `${when(a)} · ${ago(a.at)}`}</small></span>
        {progress && <span className="dv-time"><span><b>{minutes(a.position)}</b> of {minutes(a.duration)} min</span></span>}
      </span>
    </Tag>
  )
}

// ---------- Live TV ----------

/** The household's channel lists, and where the Live TV page's channels come from. A list shows only
 * the address the server masked (it may carry a paid account): the browser never keeps one. */
function LiveTvPanel({ data, shown, live, setConfirm }: { data: api.LiveTvSettings; shown?: number; live: LiveSaver; setConfirm: Confirmer }) {
  const [open, setOpen] = useState<string | 'add'>()
  const [advanced, setAdvanced] = useState(false)
  const [places, setPlaces] = useState<'countries' | 'languages'>()
  const [checking, setChecking] = useState<string>()
  const list = data.lists.find(l => l.id === open)
  const check = async (l: api.LiveTvList) => {
    setChecking(l.id)
    const why = await live(api.readLiveTvList(l.id))
    setChecking(undefined)
    return why
  }
  if (open === 'add') {
    return (
      <div className="pn-items">
        <Back onClick={() => setOpen(undefined)}>Live TV</Back>
        <NewChannelList onAdd={async (url, name) => {
          const why = await live(api.addLiveTvList(url, name), 'Channel list added')
          if (!why) setOpen(undefined)
          return why
        }} />
      </div>
    )
  }
  if (places) {
    const { countries, languages } = data.places
    return places === 'countries'
      ? <PlacePicker title="Countries" options={data.options.countries} picked={countries} any="Any country" flags
          onBack={() => setPlaces(undefined)} onPick={ids => live(api.setLiveTvPlaces(ids, languages))} />
      : <PlacePicker title="Languages" options={data.options.languages} picked={languages} any="Any language"
          onBack={() => setPlaces(undefined)} onPick={ids => live(api.setLiveTvPlaces(countries, ids))} />
  }
  if (list && advanced) {
    return <ChannelListAdvanced list={list} data={data} onBack={() => setAdvanced(false)}
      onSave={(minutes, fields) => live(api.setLiveTvListSettings(list.id, minutes, fields), 'Saved')} />
  }
  if (list) return <ChannelListDetail list={list} checking={checking === list.id} onBack={() => { setOpen(undefined); setAdvanced(false) }} onCheck={() => check(list)}
    onAdvanced={() => setAdvanced(true)}
    onRemove={() => setConfirm({
      title: `Remove ${list.name}?`,
      subtitle: 'Its channels leave Live TV, and from My channels on every profile.',
      actions: [{ icon: 'act_remove', label: `Remove ${list.name}`, run: () => { live(api.removeLiveTvList(list.id), `${list.name} removed`); setOpen(undefined) } },
                { icon: 'act_close', label: 'Keep', run: () => {} }],
    })} />
  return (
    <div className="pn-items">
      <h4 className="pn-sub">Channel lists</h4>
      {data.lists.length === 0 && <p className="pn-note top">Add a channel list (an M3U playlist's address) to watch its channels on the TVs.</p>}
      {data.lists.map(l => (
        <Row key={l.id} mark={<Mark name={l.name} />} name={l.name} status={l.error ? 'bad' : undefined}
          sub={l.error ? `Last check failed · ${l.channels.toLocaleString()} channels kept` : `${l.channels.toLocaleString()} in the list · checked ${ago(l.readAt)}`}
          onClick={() => setOpen(l.id)} />
      ))}
      {data.lists.length < data.maxLists
        ? <AddRow onClick={() => setOpen('add')}>Add a channel list</AddRow>
        : <p className="pn-note">That's the most lists ({data.maxLists}): remove one to add another.</p>}
      {data.lists.length > 0 && <LiveTvPlaces data={data} shown={shown} onOpen={setPlaces} />}
      {data.hidden > 0 && (
        <p className="pn-note">{data.hidden.toLocaleString()} {data.hidden === 1 ? "channel didn't" : "channels didn't"} play on this device, so {data.hidden === 1 ? "it's" : "they're"} hidden here for a while. Each device keeps its own: they may still play on another.</p>
      )}
    </div>
  )
}

function ChannelListDetail({ list, checking, onBack, onCheck, onAdvanced, onRemove }: {
  list: api.LiveTvList; checking: boolean; onBack: () => void; onCheck: () => Promise<string | null>; onAdvanced: () => void; onRemove: () => void
}) {
  const [why, setWhy] = useState<string | null>(null)
  return (
    <div className="pn-items">
      <Back onClick={onBack}>Live TV</Back>
      <Detail mark={<Mark name={list.name} big />} name={list.name} status={list.error ? 'bad' : 'ok'} mono
        lines={[list.address, `${list.channels.toLocaleString()} channels in the list`, list.readAt ? `Checked ${ago(list.readAt)}` : 'Not read yet']} />
      {list.error && <p className="pn-test bad">The last check failed: {list.error}. Its channels from before are still shown.</p>}
      {why && <p className="pn-test bad">{why}</p>}
      <Pill icon="act_later" sub={`Also checked every ${everyText(list.everyMinutes)}`}
        onClick={() => { if (!checking) onCheck().then(setWhy) }}>{checking ? 'Checking the list…' : 'Check now'}</Pill>
      <Pill icon="act_rate" sub={`How often to check${list.fieldsSet.length ? ` · ${list.fieldsSet.length} own ${list.fieldsSet.length === 1 ? 'tag' : 'tags'}` : ', and its tags'}`}
        onClick={onAdvanced}>Advanced</Pill>
      <Pill icon="act_remove" danger onClick={onRemove}>Remove this list</Pill>
    </div>
  )
}

/** "15 min", "1 hour", "6 hours", "1 day". */
function everyText(minutes: number) {
  if (minutes < 60) return `${minutes} min`
  if (minutes % 1440 === 0) return minutes === 1440 ? '1 day' : `${minutes / 1440} days`
  const h = Math.round(minutes / 60)
  return h === 1 ? '1 hour' : `${h} hours`
}

/** A list's Advanced settings: how often it's checked for changes, and, for a list that names things
 * its own way, which of its tags says each thing. Only tag names are shown, never their values. */
function ChannelListAdvanced({ list, data, onBack, onSave }: {
  list: api.LiveTvList; data: api.LiveTvSettings; onBack: () => void
  onSave: (minutes: number | null, fields: Record<string, string>) => Promise<string | null>
}) {
  const startFields = () => Object.fromEntries(data.roles.map(r => [r.id, list.fieldsSet.includes(r.id) ? list.fields[r.id] : '']))
  const [minutes, setMinutes] = useState<number | null>(list.refreshMinutes)
  const [fields, setFields] = useState<Record<string, string>>(startFields)
  const [open, setOpen] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [why, setWhy] = useState<string | null>(null)
  const before = startFields()
  const fieldsChanged = data.roles.some(r => (fields[r.id] ?? '') !== (before[r.id] ?? ''))
  const changed = fieldsChanged || minutes !== list.refreshMinutes
  // The default is one of the choices, marked as such (picking it follows the default, should it change).
  const choices = [...new Set([...data.refreshChoices, data.defaultRefreshMinutes])].sort((x, y) => x - y)
  const chosen = minutes ?? data.defaultRefreshMinutes
  const count = (name: string) => list.fieldsFound.find(f => f.name === name)?.count
  return (
    <form className="pn-items" onSubmit={async e => {
      e.preventDefault()
      if (!changed || busy) return
      setBusy(true); setWhy(null)
      // (A role on its default is left out: the server reads its default.)
      const sent = Object.fromEntries(Object.entries(fields).filter(([role, a]) => a && a !== data.roles.find(r => r.id === role)?.default))
      const answer = await onSave(minutes, sent)
      setBusy(false)
      if (answer) setWhy(answer)
      else onBack()
    }}>
      <Back onClick={onBack} title="Advanced">{list.name}</Back>

      <h4 className="pn-sub">Check for changes</h4>
      <div className="lt-seg" role="radiogroup" aria-label="How often to check the list for changes">
        {choices.map(m => (
          <button type="button" role="radio" aria-checked={chosen === m} key={m} className={chosen === m ? 'on' : ''}
            onClick={() => setMinutes(m === data.defaultRefreshMinutes ? null : m)}>
            {everyShort(m)}{m === data.defaultRefreshMinutes && <small>default</small>}
          </button>
        ))}
      </div>

      <h4 className="pn-sub">Tags</h4>
      <p className="pn-note top">Only for a list that uses its own tag names. Most don't.</p>
      <div className="lt-tags">
        {data.roles.map(r => {
          const value = fields[r.id] || r.default
          const own = value !== r.default
          const role = ROLES[r.id]
          // The tags this list's items have (one picked before that they've since dropped stays).
          const found = value === NO_TAG || list.fieldsFound.some(f => f.name === value) ? list.fieldsFound : [{ name: value, count: 0 }, ...list.fieldsFound]
          const isOpen = open === r.id
          return (
            <div key={r.id} className={`lt-tag${isOpen ? ' open' : ''}`}>
              <button type="button" className="lt-tag-row" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : r.id)}>
                <span className="lt-tag-name">{role?.name ?? r.name}</span>
                <code className={own ? 'own' : ''}>{value === NO_TAG ? 'none' : value}</code>
                <Icon name="chevron" size={14} />
              </button>
              {isOpen && (
                <div className="lt-tag-pick">
                  {role?.about && <p>{role.about}</p>}
                  <div className="lt-chips" role="radiogroup" aria-label={role?.name ?? r.name}>
                    {[{ name: r.default, count: count(r.default) ?? 0 }, ...found.filter(f => f.name !== r.default)].map(f => (
                      <button type="button" role="radio" aria-checked={value === f.name} key={f.name}
                        className={`lt-chip mono${value === f.name ? ' on' : ''}`}
                        onClick={() => { setFields(x => ({ ...x, [r.id]: f.name === r.default ? '' : f.name })); setOpen(null) }}>
                        {f.name}<small>{f.count ? f.count.toLocaleString() : f.name === r.default ? 'standard' : 'none now'}</small>
                      </button>
                    ))}
                    {/* (The list hasn't this at all: nothing is read for it.) */}
                    <button type="button" role="radio" aria-checked={value === NO_TAG} className={`lt-chip${value === NO_TAG ? ' on' : ''}`}
                      onClick={() => { setFields(x => ({ ...x, [r.id]: NO_TAG })); setOpen(null) }}>Not in this list</button>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {busy ? <p className="pn-test lt-save-note">{fieldsChanged ? 'Reading the list again…' : 'Saving…'}</p>
        : why ? <p className="pn-test bad lt-save-note">{why}</p> : null}
      {changed && <div className="pn-buttons"><button className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button></div>}
    </form>
  )
}

// A tag the list hasn't: the server reads nothing for it.
const NO_TAG = '-'

/** "15 min", "1 hour", "6 hours", "1 day", in a segment. */
const everyShort = (minutes: number) => everyText(minutes).replace(' hours', ' h').replace(' hour', ' h')

// What each tag says, in a word and a line (the server's role ids).
const ROLES: Record<string, { name: string; about: string }> = {
  row: { name: 'Row', about: 'The row it shows in on Live TV.' },
  start: { name: 'Start time', about: 'When it starts.' },
  end: { name: 'End time', about: 'When it ends.' },
  status: { name: 'Live, soon or 24/7', about: "Whether it's live now, coming up, or always on." },
  about: { name: 'Subtitle', about: 'The line under its name, like the league or channel.' },
  id: { name: 'Item id', about: 'Keeps it the same item when its name changes.' },
  group: { name: 'Event', about: 'Items with the same one become one card, with a choice of channels.' },
  channel: { name: 'Channel name', about: 'Its name in that choice, like “Main” or “Alternate”.' },
  country: { name: 'Country', about: "Where it's from, as a code or a name (IN, India). Show channels from goes by this. A list that puts the country in group-title: pick it here, and Category “Not in this list”." },
  language: { name: 'Language', about: "What it's in. The language choice goes by this." },
  kind: { name: 'Category', about: 'Its kind, like News or Sports: one row on Live TV each.' },
}

/** A new list: its address (an M3U playlist) and, if you like, a name. The server reads it at once. */
function NewChannelList({ onAdd }: { onAdd: (url: string, name?: string) => Promise<string | null> }) {
  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [why, setWhy] = useState<string | null>(null)
  const clean = url.trim()
  const valid = /^https?:\/\/\S+$/i.test(clean)
  return (
    <form className="pn-form" onSubmit={async e => {
      e.preventDefault()
      if (!valid || busy) return
      setBusy(true); setWhy(null)
      const answer = await onAdd(clean, name.trim() || undefined)
      setBusy(false)
      if (answer) setWhy(answer)
    }}>
      <input className="pn-input" type="url" value={url} placeholder="https://…/playlist.m3u" autoFocus spellCheck={false} autoComplete="off"
        onChange={e => { setUrl(e.target.value); setWhy(null) }} aria-label="The list's address" />
      <input className="pn-input" value={name} placeholder="A name for it (optional)" maxLength={40} autoComplete="off"
        onChange={e => setName(e.target.value)} aria-label="Its name" />
      {busy ? <p className="pn-test">Checking the list… This can take a few seconds.</p>
        : why ? <p className="pn-test bad">{why}</p>
        : clean && !valid ? <p className="pn-test">An address starts with https://</p> : null}
      <div className="pn-buttons"><button className="btn primary" disabled={!valid || busy}>{busy ? 'Checking…' : 'Add'}</button></div>
    </form>
  )
}

/** "Show channels from": two rows on the Live TV page, countries and (when the lists say them)
 * languages, each opening a page to pick from. Nothing picked: any. Each pick is saved at once. */
function LiveTvPlaces({ data, shown, onOpen }: { data: api.LiveTvSettings; shown?: number; onOpen: (which: 'countries' | 'languages') => void }) {
  const { countries, languages } = data.places
  // (One place only, e.g. a list that gives no countries: nothing to choose.)
  if (data.options.countries.length < 2 && countries.length === 0 && !data.languagesSaid) return null
  const names = (ids: string[], options: PlaceOption[], any: string) => {
    const picked = options.filter(o => ids.includes(o.id)).map(placeName).sort((x, y) => x.localeCompare(y))
    return picked.length === 0 ? any : picked.length <= 3 ? picked.join(', ') : `${picked.slice(0, 2).join(', ')} and ${picked.length - 2} more`
  }
  return (
    <>
      <h4 className="pn-sub">Show channels from</h4>
      {shown != null && <p className="pn-note top">Live TV shows {shown.toLocaleString()} {shown === 1 ? 'channel' : 'channels'}.</p>}
      <Row mark={<span className="mark lt-flag" aria-hidden>{countries.length === 1 ? flag(countries[0]) : '🌐'}</span>}
        name="Countries" sub={names(countries, data.options.countries, 'Any country')} onClick={() => onOpen('countries')} />
      {data.languagesSaid && (
        <Row mark={<span className="mark lt-flag lang" aria-hidden>Aa</span>}
          name="Languages" sub={names(languages, data.options.languages, 'Any language')} onClick={() => onOpen('languages')} />
      )}
    </>
  )
}

type PlaceOption = { id: string; name: string; count: number }
const placeName = (o: PlaceOption) => (o.id === 'INT' ? 'International' : o.id === 'none' ? 'Not said' : o.name)
/** A country's flag (its two letters as regional indicators); the globe for international. */
const flag = (id: string) => (/^[A-Z]{2}$/.test(id) ? String.fromCodePoint(...[...id].map(c => 0x1f1a5 + c.charCodeAt(0))) : '🌐')

/** Countries or languages to show channels from: a search, "Any", the picked ones, then A to Z with a
 * letter over each run. A tap picks or unpicks at once. */
function PlacePicker({ title, options, picked, any, flags, onBack, onPick }: {
  title: string; options: PlaceOption[]; picked: string[]; any: string; flags?: boolean
  onBack: () => void; onPick: (ids: string[]) => void
}) {
  const [q, setQ] = useState('')
  const term = q.trim().toLowerCase()
  const byName = (x: PlaceOption, y: PlaceOption) => Number(x.id === 'none') - Number(y.id === 'none') || placeName(x).localeCompare(placeName(y))
  // (A word starting with what's typed: "ba" finds Bahamas, not Albania.)
  const shown = options.filter(o => !term || placeName(o).toLowerCase().split(/[\s&,.()-]+/).some(w => w.startsWith(term)) || placeName(o).toLowerCase().startsWith(term)).sort(byName)
  const mine = shown.filter(o => picked.includes(o.id))
  const rest = shown.filter(o => !picked.includes(o.id))
  const row = (o: PlaceOption) => {
    const on = picked.includes(o.id)
    return (
      <button key={o.id} role="checkbox" aria-checked={on} className={`lt-place${on ? ' on' : ''}`}
        onClick={() => onPick(on ? picked.filter(x => x !== o.id) : [...picked, o.id])}>
        {flags && <span className="lt-place-flag" aria-hidden>{flag(o.id)}</span>}
        <span className="lt-place-name">{placeName(o)}</span>
        <span className="lt-place-count">{o.count.toLocaleString()}</span>
        <span className="lt-place-tick" aria-hidden>{on && <Icon name="check" size={13} />}</span>
      </button>
    )
  }
  let letter = ''
  return (
    <div className="pn-items">
      <Back onClick={onBack} title={title}>Live TV</Back>
      <label className="lt-search">
        <Icon name="search" size={18} />
        <input type="search" value={q} placeholder={`Search ${options.length} ${title.toLowerCase()}`} onChange={e => setQ(e.target.value)}
          aria-label={`Search ${title.toLowerCase()}`} autoComplete="off" spellCheck={false} />
      </label>
      <div className="lt-places">
        {!term && (
          <button role="checkbox" aria-checked={picked.length === 0} className={`lt-place any${picked.length === 0 ? ' on' : ''}`} onClick={() => onPick([])}>
            {flags && <span className="lt-place-flag" aria-hidden>🌐</span>}
            <span className="lt-place-name">{any}</span>
            <span className="lt-place-tick" aria-hidden>{picked.length === 0 && <Icon name="check" size={13} />}</span>
          </button>
        )}
        {mine.length > 0 && <h5 className="lt-letter">Showing</h5>}
        {mine.map(row)}
        {rest.map(o => {
          const first = placeName(o)[0].toUpperCase()
          const head = first !== letter && !term && rest.length > LIVE_LETTERS
          letter = first
          return [head && <h5 key={`h${first}`} className="lt-letter">{first}</h5>, row(o)]
        })}
        {term && shown.length === 0 && <p className="pn-note lt-none">Nothing called “{q.trim()}” in your lists.</p>}
      </div>
    </div>
  )
}

// (Fewer than this to choose from: no letters over them.)
const LIVE_LETTERS = 12

function DeviceName({ current, onSave }: { current: string; onSave: (name: string) => void }) {
  const lim = useLimitsReady()
  const [name, setName] = useState(current)
  const clean = name.trim()
  return (
    <form className="pn-form" onSubmit={e => { e.preventDefault(); if (clean && clean !== current) onSave(clean) }}>
      <h4 className="pn-sub">Its name</h4>
      <input className="pn-input" value={name} onChange={e => setName(e.target.value)} maxLength={lim.names.device} autoFocus aria-label="Device name" />
      <div className="pn-buttons"><button className="btn primary" disabled={!clean || clean === current}>Save</button></div>
    </form>
  )
}

/** A TV or a browser, drawn in a small disc. */
function DeviceMark({ device, big }: { device: api.Device; big?: boolean }) {
  const tv = api.deviceKind(device) === 'tv'
  return (
    <span className={`mark${big ? ' big' : ''}${tv ? ' lamp' : ''}`} aria-hidden>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        {tv
          ? <><rect x="3" y="5" width="18" height="12" rx="2" /><path d="M8 20h8M12 17v3" /></>
          : <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M6.5 6.5h.01M9 6.5h.01" /></>}
      </svg>
    </span>
  )
}

// ---------- Sources and keys ----------

function SourcesSummary({ sources: s }: { sources?: api.Sources }) {
  if (!s) return <><span className="st-big">Add-ons, AI key</span><span className="st-small">Loading…</span></>
  const extras = s.streamAddons.length + s.subtitleAddons.length
  const nightcap = s.nightcapAiostreams
  // Where streams come from: the link services given (through Nightcap's AIOStreams), or an AIOStreams of its own.
  const keyed = nightcap?.inUse ? nightcap.services.filter(x => x.key).map(x => x.name) : []
  const streams = s.aiostreams ? 'AIOStreams' : keyed.length ? keyed.join(' + ') : nightcap?.inUse ? 'Streams' : 'AIOStreams'
  return (
    <>
      <span className="st-dots">
        <span className={s.aiostreams || keyed.length ? 'on' : ''}><i>{s.aiostreams || keyed.length ? '●' : '○'}</i>{streams}</span>
        {/* (Off while the AI can't be used: no model, or the key needed again.) */}
        <span className={s.ai?.provider && s.ai.model ? 'on' : ''}><i>{s.ai?.provider && s.ai.model ? '●' : '○'}</i>AI key</span>
      </span>
      <span className={`st-small${s.failedLately.length ? ' st-lamp' : ''}`}>
        {extras} more {extras === 1 ? 'add-on' : 'add-ons'}{s.failedLately.length ? ` · ${s.failedLately.length} failed lately` : ''}
      </span>
    </>
  )
}

type Saver = (job: Promise<unknown>, done: string) => Promise<void>
type AiSaver = (job: Promise<api.Sources>, done: string) => Promise<string | null>
type LiveSaver = (job: Promise<api.LiveTvSettings>, done?: string) => Promise<string | null>
type Confirmer = (c: { title: string; subtitle?: string; actions: Action[] } | undefined) => void

const FAILURE: Record<string, string> = { lookup_failed: "didn't answer", lookup_timed_out: 'was too slow to answer', wont_play: "gave streams that wouldn't play" }

/** What's open in the Sources panel: the list, one saved source, or a new one being added. */
type Open =
  | { kind: 'aio' } | { kind: 'ai' } | { kind: 'ai-model' }
  | { kind: api.AddonKind; id: string }
  | { kind: 'debrid'; id: string }
  | { kind: 'add'; what: 'aio' | api.AddonKind | 'ai' }
  | { kind: 'add'; what: 'debrid'; id?: string }

const host = (address: string) => address.replace(/^https?:\/\//, '').split('/')[0]
/** A name for an add-on until it says its own: its host, or for a long one (a cloud service's,
 * "name-123456789.region.run.app") just its first part ("name"), so the row stays one line. */
const shortName = (address: string) => {
  const h = host(address).replace(/^www\./, '')
  return h.length > 24 ? h.split('.')[0].replace(/-\d{6,}$/, '') : h
}
const testKey = (o: { kind: string; id?: string }) => `${o.kind}:${o.id ?? ''}`

function SourcesPanel({ sources: s, save, saveAi, setConfirm, onRefresh }: { sources: api.Sources; save: Saver; saveAi: AiSaver; setConfirm: Confirmer; onRefresh: () => void }) {
  const lim = useLimitsReady()
  const [open, setOpen] = useState<Open>()
  // Each saved source is tested once when the panel opens: the answers give add-ons their names
  // (from their manifests) and the dots their colour. Testing only reads. A last-resort add-on isn't
  // (its service is asleep most of the time, and a test would wake it for nothing): only by Test again.
  // Nor the AI: its test asks the model a question (charged, up to 30 s). A test that finds an add-on is one has the server mark it, so the
  // list is fetched again to show that.
  const [tests, setTests] = useState<Record<string, api.TestResult | 'testing'>>({})
  // (Each source's latest test only: an answer for one forgotten or tested again since is dropped.)
  const testRun = useRef<Record<string, number>>({})
  const runTest = useCallback((key: string, what: Record<string, string | null | undefined>) => {
    const mine = (testRun.current[key] ?? 0) + 1
    testRun.current[key] = mine
    const latest = () => testRun.current[key] === mine
    setTests(t => ({ ...t, [key]: 'testing' }))
    api.testSource(what).then(r => {
      if (!latest()) return
      setTests(t => ({ ...t, [key]: r }))
      if (r.lastResort) onRefresh()
    }, e => { if (latest()) setTests(t => ({ ...t, [key]: { ok: false, error: isOffline(e) ? WORDS.offline : (e as Error).message } })) })
  }, [onRefresh])
  const saved = [
    ...(s.aiostreams ? [{ key: testKey({ kind: 'aio' }), what: { what: 'aiostreams' } }] : []),
    ...s.streamAddons.map(a => ({ key: testKey({ kind: 'stream', id: a.id }), what: { what: 'stream', id: a.id } })),
    ...s.subtitleAddons.map(a => ({ key: testKey({ kind: 'subtitle', id: a.id }), what: { what: 'subtitle', id: a.id } })),
    // (No test while there's no model: the server can't ask one.)
    ...(s.ai?.model ? [{ key: testKey({ kind: 'ai' }), what: { what: 'ai' } }] : []),
  ]
  const savedKeys = saved.map(x => x.key).join(',')
  const aiKey = testKey({ kind: 'ai' })
  const sleeping = new Set([...s.streamAddons.filter(a => a.lastResort).map(a => testKey({ kind: 'stream', id: a.id })), aiKey])
  useEffect(() => {
    saved.forEach(x => { if (!(x.key in tests) && !sleeping.has(x.key)) runTest(x.key, x.what) })
  }, [savedKeys])

  const nameOf = (key: string, fallback: string) => { const t = tests[key]; return t && t !== 'testing' && t.name ? t.name : fallback }
  const failed = (name: string) => s.failedLately.find(f => f.addon.toLowerCase() === name.toLowerCase())
  // The AI saved or removed: its last test was the old one's.
  const forgetAiTest = () => {
    testRun.current[aiKey] = (testRun.current[aiKey] ?? 0) + 1
    setTests(t => { const next = { ...t }; delete next[aiKey]; return next })
  }
  const aiSaved: AiSaver = async (job, done) => {
    const why = await saveAi(job, done)
    if (!why) { forgetAiTest(); setOpen(undefined) }
    return why
  }
  const aiName = s.ai?.providerName ?? 'AI'
  const statusOf = (key: string, name: string): Status => {
    const t = tests[key]
    if (t === 'testing') return 'testing'
    if (t && !t.ok) return 'bad'
    if (failed(name)) return 'warn'
    return t ? 'ok' : undefined
  }
  const remove = (what: string, job: () => Promise<unknown>, done: string) => setConfirm({
    title: `Remove ${what}?`, subtitle: 'The TV stops using it at once.',
    actions: [{ icon: 'act_remove', label: `Remove ${what}`, run: () => { setOpen(undefined); save(job(), done) } },
              { icon: 'act_close', label: 'Keep', run: () => {} }],
  })

  // ---------- One source ----------
  const nightcap = s.nightcapAiostreams
  const service = (id?: string) => nightcap?.services.find(x => x.id === id)
  if (open?.kind === 'add' && open.what === 'debrid') {
    const chosen = service(open.id)
    return (
      <div className="pn-items">
        <Back onClick={() => setOpen(chosen && !chosen.key ? { kind: 'add', what: 'debrid' } : undefined)}
          title={chosen ? `${chosen.name} key` : 'Add a link service'}>{chosen && !chosen.key ? 'Link services' : 'Sources and keys'}</Back>
        {chosen ? (
          <>
            <NewDebridKey name={chosen.name}
              onSave={key => { setOpen(undefined); return save(api.setDebridKey(chosen.id, key), `${chosen.name} key saved`) }} />
          </>
        ) : (
          <>
            {nightcap?.services.filter(x => !x.key).map(x => (
              <Row key={x.id} mark={<Mark name={x.name} />} name={x.name} onClick={() => setOpen({ kind: 'add', what: 'debrid', id: x.id })} />
            ))}
          </>
        )}
      </div>
    )
  }
  if (open?.kind === 'debrid') {
    const x = service(open.id)
    return (
      <div className="pn-items">
        <Back onClick={() => setOpen(undefined)}>Sources and keys</Back>
        {x && <Detail mark={<Mark name={x.name} big />} name={x.name} mono
          lines={[`Key ${x.key ?? ''}`, nightcap?.inUse ? 'Streams come through it.' : 'Not in use while your own AIOStreams address is set.']} />}
        {x && <Pill icon="act_unwatched" onClick={() => setOpen({ kind: 'add', what: 'debrid', id: x.id })}>Replace the key</Pill>}
        {x && <Pill icon="act_remove" danger onClick={() => setConfirm({
          title: `Remove the ${x.name} key?`,
          subtitle: nightcap?.services.some(y => y.key && y.id !== x.id) ? 'The other services keep working.' : 'Without a link service key, only files add-ons host themselves can play.',
          actions: [{ icon: 'act_remove', label: `Remove the ${x.name} key`, run: () => { setOpen(undefined); save(api.setDebridKey(x.id, null), `${x.name} key removed`) } },
                    { icon: 'act_close', label: 'Keep', run: () => {} }],
        })}>Remove</Pill>}
      </div>
    )
  }
  if (open?.kind === 'ai-model' && s.ai?.provider) {
    return (
      <div className="pn-items">
        <Back onClick={() => setOpen({ kind: 'ai' })} title="Change model">{aiName}</Back>
        <AiForm providers={s.providers} saved={s.ai} onSave={body => aiSaved(api.setAi(body), 'AI model saved')} onLocked={e => saveAi(Promise.reject(e), '')} />
      </div>
    )
  }
  if (open?.kind === 'add') {
    const what = open.what
    const title = { aio: 'AIOStreams address', stream: 'Stream add-on', subtitle: 'Subtitle add-on', ai: 'AI' }[what as 'aio' | 'stream' | 'subtitle' | 'ai']
    return (
      <div className="pn-items">
        <Back onClick={() => setOpen(undefined)} title={title}>Sources and keys</Back>
        {what === 'ai'
          ? <AiForm providers={s.providers} replacing={s.ai} onSave={body => aiSaved(api.setAi(body), 'AI saved')} onLocked={e => saveAi(Promise.reject(e), '')} />
          : <NewAddress testAs={what === 'aio' ? 'stream' : what as api.AddonKind} label={what === 'aio' ? 'Save' : 'Add'}
              onSave={url => { setOpen(undefined); return save(what === 'aio' ? api.setAiostreams(url) : api.addAddon(what as api.AddonKind, url), what === 'aio' ? 'AIOStreams address saved' : 'Add-on added') }} />}
      </div>
    )
  }
  if (open) {
    const key = testKey(open as { kind: string; id?: string })
    const t = tests[key]
    let name = '', address = '', fallback = '', replaceAs: 'aio' | 'ai' | undefined
    let removeIt: () => void = () => {}
    if (open.kind === 'aio' && s.aiostreams) {
      fallback = 'AIOStreams'; address = s.aiostreams.address; replaceAs = 'aio'
      removeIt = () => remove('the AIOStreams address', () => api.setAiostreams(null), 'AIOStreams address removed')
    } else if (open.kind === 'ai' && s.ai) {
      const ai = s.ai
      fallback = aiName; address = `Key ${ai.key}`; replaceAs = 'ai'
      removeIt = () => remove('the AI', () => api.setAi(removeBody(ai, s.providers)).then(r => { forgetAiTest(); return r }), 'AI removed')
    } else if (open.kind === 'stream' || open.kind === 'subtitle') {
      const kind = open.kind
      const a = (kind === 'stream' ? s.streamAddons : s.subtitleAddons).find(x => x.id === open.id)
      if (a) {
        fallback = shortName(a.address); address = a.address
        removeIt = () => remove('this add-on', () => api.removeAddon(kind, a.id), 'Add-on removed')
      }
    }
    name = open.kind === 'ai' ? fallback : nameOf(key, fallback)
    const ai = open.kind === 'ai' ? s.ai : null
    const aiLines = ai ? [
      ai.model ? `Model ${ai.model}` : '',
      ai.baseUrl ? `Address ${ai.baseUrl}` : '',
      ai.model ? (ai.price ? (ai.price[0] === 0 && ai.price[1] === 0 ? 'Free' : `$${ai.price[0]} in · $${ai.price[1]} out, per million tokens`) : "Price unknown: spending isn't counted") : '',
      aiBlocked(ai) ?? '',
    ] : []
    const f = failed(name)
    const test = saved.find(x => x.key === key)
    return (
      <div className="pn-items">
        <Back onClick={() => setOpen(undefined)}>Sources and keys</Back>
        <Detail mark={<Mark name={name} big />} name={name} status={ai && aiBlocked(ai) ? 'bad' : statusOf(key, name)}
          lines={[address, ...aiLines,
            t === 'testing' ? 'Testing…' : t?.ok ? `Works${t.version ? ` · version ${t.version}` : ''}` : t ? (t.error ?? "Didn't work") : '',
            f ? `${f.times === 1 ? 'Once' : `${f.times} times`} lately it ${FAILURE[f.kind] ?? f.kind}, last ${ago(f.last)}` : ''].filter(Boolean)} mono />
        {test && <Pill icon="act_watched" onClick={() => runTest(key, test.what)}>{t === 'testing' ? 'Testing…' : t ? 'Test again' : 'Test'}</Pill>}
        {ai?.provider && <Pill icon="act_rate" onClick={() => setOpen({ kind: 'ai-model' })}>{ai.model ? 'Change model' : 'Choose a model'}</Pill>}
        {replaceAs && <Pill icon="act_unwatched" onClick={() => setOpen({ kind: 'add', what: replaceAs! })}>{ai && !ai.provider ? 'Add the key again' : 'Replace'}</Pill>}
        <Pill icon="act_remove" danger onClick={removeIt}>Remove</Pill>
      </div>
    )
  }

  // ---------- The list ----------
  const addonRows = (kind: api.AddonKind, list: api.Addon[]) => list.map(a => {
    const key = testKey({ kind, id: a.id })
    const name = nameOf(key, shortName(a.address))
    return <Row key={a.id} mark={<Mark name={name} />} name={name} sub={host(a.address)} status={statusOf(key, name)} onClick={() => setOpen({ kind, id: a.id })} />
  })
  const offered = nightcap?.available
  const keys = nightcap?.services.filter(x => x.key) ?? []
  return (
    <div className="pn-items">
      {offered && (
        <>
          <h4 className="pn-sub">Link services</h4>
          {!nightcap?.inUse ? <p className="pn-note top">Not in use: your own AIOStreams is.</p>
            : !keys.length ? <p className="pn-note top">No key: only free files play.</p> : null}
          {keys.map(x => <Row key={x.id} mark={<Mark name={x.name} />} name={x.name} sub={`Key ${x.key}`} status={nightcap?.inUse ? 'ok' : undefined} onClick={() => setOpen({ kind: 'debrid', id: x.id })} />)}
          {keys.length < (nightcap?.services.length ?? 0) && <AddRow onClick={() => setOpen({ kind: 'add', what: 'debrid' })}>Add a link service</AddRow>}
        </>
      )}

      <h4 className="pn-sub">{offered ? 'Own AIOStreams (advanced)' : 'AIOStreams'}</h4>
      {s.aiostreams ? (() => {
        const key = testKey({ kind: 'aio' })
        const name = nameOf(key, 'AIOStreams')
        return <Row mark={<Mark name={name} />} name={name} sub={host(s.aiostreams.address)} status={statusOf(key, name)} onClick={() => setOpen({ kind: 'aio' })} />
      })() : <AddRow onClick={() => setOpen({ kind: 'add', what: 'aio' })}>{offered ? 'Use your own instead' : 'Add your AIOStreams address'}</AddRow>}

      <h4 className="pn-sub">Extra streams</h4>
      {addonRows('stream', s.streamAddons)}
      {s.streamAddons.length < lim.maxAddons && <AddRow onClick={() => setOpen({ kind: 'add', what: 'stream' })}>Add a stream add-on</AddRow>}

      <h4 className="pn-sub">Subtitles</h4>
      {addonRows('subtitle', s.subtitleAddons)}
      {s.subtitleAddons.length < lim.maxAddons && <AddRow onClick={() => setOpen({ kind: 'add', what: 'subtitle' })}>Add a subtitle add-on</AddRow>}

      <h4 className="pn-sub">AI</h4>
      {s.ai ? (() => {
        const key = testKey({ kind: 'ai' })
        const ai = s.ai
        const blocked = aiBlocked(ai)
        return <Row mark={<Mark name="AI" />} name={aiName}
          sub={blocked ?? [ai.model, `Key ${ai.key}`, ai.model && !ai.price ? "Price unknown: spending isn't counted" : null].filter(Boolean).join(' · ')}
          status={blocked ? 'bad' : statusOf(key, aiName)} onClick={() => setOpen({ kind: 'ai' })} />
      })() : <AddRow onClick={() => setOpen({ kind: 'add', what: 'ai' })}>Add an AI</AddRow>}
    </div>
  )
}

// ---------- Rows, details and forms for the household panels ----------

/** A new add-on address: tested before it's saved, if you like. */
function NewAddress({ testAs, label, onSave }: { testAs: api.AddonKind; label: string; onSave: (url: string) => void }) {
  const [url, setUrl] = useState('')
  const [result, run, busy] = useTest()
  const clean = url.trim()
  const valid = /^https?:\/\/\S+\/manifest\.json$/i.test(clean)
  return (
    <form className="pn-form" onSubmit={e => { e.preventDefault(); if (valid) onSave(clean) }}>
      <input className="pn-input" value={url} placeholder="https://…/manifest.json" autoFocus spellCheck={false} autoComplete="off"
        onChange={e => setUrl(e.target.value)} aria-label="Address" />
      <TestLine result={result} hint={clean && !valid ? 'An address starts with https:// and ends with /manifest.json' : undefined} />
      <div className="pn-buttons">
        <button type="button" className="btn" disabled={!valid || busy} onClick={() => run({ what: testAs, url: clean })}>{busy ? 'Testing…' : 'Test'}</button>
        <button className="btn primary" disabled={!valid}>{label}</button>
      </div>
    </form>
  )
}

/** The household's AI: provider, key (and the address, for "Other"), then a model picked from the ones
 * the key can use. With [saved], only the model (and its price) changes, with the saved key; with
 * [replacing], the form starts on the saved provider. A model whose price Nightcap doesn't know still
 * works: it's said, and the price can be given under Advanced. (The rules: aiForm.ts.) */
function AiForm({ providers, saved, replacing, onSave, onLocked }: {
  providers: api.AiProvider[]; saved?: NonNullable<api.Sources['ai']>; replacing?: api.Sources['ai']
  onSave: (body: api.AiSave) => Promise<string | null>
  /** The admin session ended while asking for the models or testing: as for a save, the PIN. */
  onLocked: (e: api.AdminLocked) => void
}) {
  const changing = !!saved
  const [provider, setProvider] = useState(saved?.provider ?? replacing?.provider ?? providers[0]?.id ?? '')
  const [key, setKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [models, setModels] = useState<api.AiModel[] | 'loading' | { error: string }>()
  const [model, setModelValue] = useState(saved?.model ?? '')
  const start = priceFields(saved?.model ?? '', saved)
  const [priceIn, setPriceIn] = useState(start.input)
  const [priceOut, setPriceOut] = useState(start.output)
  const [free, setFree] = useState(start.free)
  const [advanced, setAdvanced] = useState(false)
  const [saving, setSaving] = useState(false)
  const [why, setWhy] = useState<string>()
  const [result, run, busy, clearTest] = useTest(onLocked)
  const p = providers.find(x => x.id === provider)
  const needsBaseUrl = !!p?.needsBaseUrl
  const keyOk = changing || keyLooksRight(provider, key)
  const urlOk = changing || !needsBaseUrl || /^https?:\/\/\S+$/i.test(baseUrl.trim())

  // A model picked: its own price fields (the saved price only for the saved model, never the last
  // model's), and no old test result.
  const setModel = (m: string) => {
    setModelValue(m)
    const f = priceFields(m, saved)
    setPriceIn(f.input); setPriceOut(f.output); setFree(f.free)
    clearTest(); setWhy(undefined)
  }
  // (Only the latest ask's answer is kept; the same provider, key and address aren't asked twice.)
  const asked = useRef(0)
  const lastAsk = useRef('')
  const loadModels = useCallback((again = false) => {
    if (!provider || !keyOk || !urlOk) return
    const ask = JSON.stringify([provider, changing ? '' : key.trim(), changing ? '' : baseUrl.trim()])
    if (!again && ask === lastAsk.current) return
    lastAsk.current = ask
    const mine = ++asked.current
    setModels('loading')
    api.aiModels(provider, changing ? null : key.trim(), changing ? null : baseUrl.trim() || null)
      .then(list => { if (asked.current === mine) setModels(list) },
        e => {
          if (asked.current !== mine) return
          if (e instanceof api.AdminLocked) { onLocked(e); return }
          setModels({ error: errorWords(e) }); lastAsk.current = ''
        })
  }, [provider, keyOk, urlOk, changing, key, baseUrl])
  // Changing the model: the list comes as the form opens (with the saved key).
  useEffect(() => { if (changing) loadModels() }, [])
  // A new provider, key or address: its own list, and a model picked from it.
  const reset = () => { asked.current++; lastAsk.current = ''; setModels(undefined); setModel('') }

  const list = Array.isArray(models) ? models : undefined
  const failed = models && typeof models === 'object' && !Array.isArray(models) ? models.error : undefined
  const chosen = list?.find(m => m.id === model)
  const typeModel = !!failed || (!!list && !list.length)
  const typed = readPrice(priceIn, priceOut, free)
  // (Claude's and OpenRouter's prices are known to the server; the list says for the rest.)
  const priceUnknown = !!model && !chosen?.price && typed.kind === 'none'
  const ready = !!model.trim() && keyOk && urlOk && !saving && typed.kind !== 'bad'
  const form = { changing, provider, key, baseUrl, needsBaseUrl, model }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!ready) return
    setSaving(true); setWhy(undefined)
    const failedWith = await onSave(saveBody({ ...form, price: typed.kind === 'price' ? typed.price : null }))
    setSaving(false)
    if (failedWith) setWhy(failedWith)
  }

  return (
    <form className="pn-form" onSubmit={submit}>
      {!changing && providers.length > 1 && (
        <select className="pn-input" value={provider} onChange={e => { setProvider(e.target.value); reset() }} aria-label="AI provider">
          {providers.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
      )}
      {!changing && (
        <input className="pn-input" type="password" value={key} autoFocus autoComplete="off" spellCheck={false}
          placeholder={`${p?.name ?? 'AI'} key`} onChange={e => { setKey(e.target.value); reset() }} onBlur={() => loadModels()} aria-label="AI key" />
      )}
      {!changing && needsBaseUrl && (
        <input className="pn-input" value={baseUrl} autoComplete="off" spellCheck={false} inputMode="url"
          placeholder="Its address (https://…/v1)" onChange={e => { setBaseUrl(e.target.value); reset() }} onBlur={() => loadModels()} aria-label="AI address" />
      )}
      {/* (No list: the address can't list its models, or listing failed. The model's name is typed then.) */}
      {typeModel
        ? <input className="pn-input" value={model} autoComplete="off" spellCheck={false} placeholder="The model's name (as the AI calls it)"
            onChange={e => setModel(e.target.value)} aria-label="Model" />
        : <select className="pn-input" value={model} disabled={!list?.length} autoFocus={changing} onChange={e => setModel(e.target.value)} aria-label="Model">
        <option value="">{models === 'loading' ? 'Finding the models…' : list ? (list.length ? 'Choose a model' : 'No models found') : changing ? 'Choose a model' : 'Choose a model (after the key)'}</option>
        {/* (The saved model, if the list hasn't it.) */}
        {changing && saved?.model && !list?.some(m => m.id === saved.model) && <option value={saved.model}>{saved.model}</option>}
        {list?.map(m => <option key={m.id} value={m.id}>{m.id}{m.price ? `  ·  $${m.price[0]} / $${m.price[1]} per million tokens` : ''}</option>)}
      </select>}
      {failed && <p className="pn-test bad">Couldn't list its models ({failed}). Type the model's name instead, or try again.</p>}
      {list && !list.length && <p className="pn-note">It doesn't list its models. Type the model's name instead.</p>}
      {(failed || (!list && models !== 'loading' && !changing)) && (
        <button type="button" className="btn" disabled={!keyOk || !urlOk} onMouseDown={e => e.preventDefault()} onClick={() => loadModels(!!failed)}>{failed ? 'Try again' : 'Show models'}</button>
      )}
      {priceUnknown && <p className="pn-note warn">Nightcap doesn't know this model's price, so it can't count your AI spending or keep to your monthly limit.</p>}
      {/* (Only for a model whose price the server doesn't know: for one it does, a price given is ignored.) */}
      {model && !chosen?.price && (
        <details className="pn-advanced" open={advanced || typed.kind === 'bad'} onToggle={e => setAdvanced((e.currentTarget as HTMLDetailsElement).open)}>
          <summary>Advanced</summary>
          <p className="pn-note top">The model's price, if you know it (US$ per million tokens). Given, spending is counted and the monthly limit applies. Left empty, it isn't.</p>
          <div className="pn-price">
            <input className="pn-input" value={priceIn} inputMode="decimal" placeholder="In" disabled={free} onChange={e => setPriceIn(e.target.value)} aria-label="Price in, per million tokens" />
            <input className="pn-input" value={priceOut} inputMode="decimal" placeholder="Out" disabled={free} onChange={e => setPriceOut(e.target.value)} aria-label="Price out, per million tokens" />
            <label className="pn-check"><input type="checkbox" checked={free} onChange={e => setFree(e.target.checked)} /> Free</label>
          </div>
          {typed.kind === 'bad' && <p className="pn-test bad">A price is two numbers: US dollars per million tokens in, and out.</p>}
        </details>
      )}
      <TestLine result={result} hint="Testing asks the model one tiny question (a fraction of a cent). It can take up to 30 seconds." />
      {why && <p className="pn-test bad">{why}</p>}
      <div className="pn-buttons">
        <button type="button" className="btn" disabled={!model.trim() || !keyOk || !urlOk || busy || saving} onClick={() => run(testBody(form))}>{busy ? 'Testing…' : 'Test'}</button>
        <button className="btn primary" disabled={!ready}>{saving ? 'Saving…' : 'Save'}</button>
      </div>
    </form>
  )
}

/** A link service's key: saved straight away (the household's setup is updated with it). */
function NewDebridKey({ name, onSave }: { name: string; onSave: (key: string) => void }) {
  const [key, setKey] = useState('')
  const clean = key.trim()
  const valid = clean.length >= 8 && !/\s/.test(clean)
  return (
    <form className="pn-form" onSubmit={e => { e.preventDefault(); if (valid) onSave(clean) }}>
      <input className="pn-input" type="password" value={key} autoFocus autoComplete="off" spellCheck={false}
        placeholder={`${name} API key`} onChange={e => setKey(e.target.value)} aria-label={`${name} API key`} />
      <p className="pn-test">Find it in your {name} account settings.</p>
      <div className="pn-buttons"><button className="btn primary" disabled={!valid}>Save</button></div>
    </form>
  )
}

/** [result, run, busy] for a Test button. */
function useTest(onLocked?: (e: api.AdminLocked) => void) {
  const [result, setResult] = useState<api.TestResult>()
  const [busy, setBusy] = useState(false)
  // (Only the latest test's answer is shown: one still on its way for another model, key or address,
  // or one cleared, is dropped when it comes.)
  const latest = useRef(0)
  const run = async (what: Record<string, string | null | undefined>) => {
    const mine = ++latest.current
    setBusy(true); setResult(undefined)
    let answer: api.TestResult
    try { answer = await api.testSource(what) } catch (e) {
      if (e instanceof api.AdminLocked && onLocked) { if (latest.current === mine) { setBusy(false); onLocked(e) } return }
      answer = { ok: false, error: isOffline(e) ? WORDS.offline : (e as Error).message }
    }
    if (latest.current !== mine) return
    setResult(answer); setBusy(false)
  }
  const clear = useCallback(() => { latest.current++; setResult(undefined); setBusy(false) }, [])
  return [result, run, busy, clear] as const
}

function TestLine({ result, hint }: { result?: api.TestResult; hint?: string }) {
  if (!result) return hint ? <p className="pn-test">{hint}</p> : null
  return result.ok
    ? <p className="pn-test good">Works{result.name ? `: ${result.name}${result.version ? ` ${result.version}` : ''}` : ''}</p>
    : <p className="pn-test bad">{result.error ?? "Didn't work"}</p>
}

/** (It waits for the server's limits: names, the PIN, how many.) */
export default function Settings() {
  return <WithLimits><SettingsScreen /></WithLimits>
}

/** Settings' shape while it comes (after 300 ms: a quick answer shows nothing in between). */
function SettingsSkeleton() {
  const [shown, setShown] = useState(false)
  useEffect(() => { const t = setTimeout(() => setShown(true), 300); return () => clearTimeout(t) }, [])
  return (
    <div className="st" role="status" aria-label="Loading">
      {shown && (
        <>
          <div className="st-top"><span className="eyebrow st-eyebrow">Settings</span></div>
          <div className="st-skeleton">
            <span className="skeleton st-skeleton-face" />
            <span className="skeleton skeleton-line" style={{ width: 240, height: 40 }} />
            <div className="st-skeleton-tiles">
              {[0, 1, 2, 3].map(i => <span key={i} className="skeleton st-skeleton-tile" style={{ animationDelay: `${i * 80}ms` }} />)}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
