import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import * as api from '../api'
import { avatarOf, avatarSrc } from '../avatars'
import BackButton from '../components/BackButton'
import Icon from '../components/Icon'
import Invites from '../components/Invites'
import { useNotice } from '../components/Notice'
import { Back, Pill } from '../components/PanelParts'
import type { Profile } from '../types'
import './Profiles.css' // the Who's watching look: the glow, the title
import './Setup.css' // the household tiles
import './Settings.css' // the side panel
import '../components/PlayOnTv.css' // the ✓ of a finished import
import './Owner.css'
import { useLimitsReady } from '../limits'
import WithLimits from '../components/WithLimits'
import Waiting from '../components/Waiting'
import { errorWords, WORDS } from '../errors'

// The server's owner (whoever deployed it), after the Connect screen: the households on this
// server as glass tiles over the glow, and a "New household" tile. A tile opens the side panel
// (as Sources and keys): the household, its invites, and its choices as pills. Reached at /server
// with the owner key, kept for this tab only (see api.ownerKey).

const MARK = `${import.meta.env.BASE_URL}brand/mark.png`
const GLOW = '#2E3F7A'
const NEW_GLOW = '#24506A'

type Panel = { kind: 'new' } | { kind: 'move' } | { kind: 'household'; id: string }

function OwnerScreen() {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.ownerHouseholds>>>()
  const [needKey, setNeedKey] = useState(!api.ownerKey.get())
  const [error, setError] = useState<string>()
  const [panel, setPanel] = useState<Panel>()
  const [glow, setGlow] = useState(GLOW)
  const [notice, notify] = useNotice()
  // Invites made on this page: their codes, shown until the page is left (the server answers a code only once).
  const [fresh, setFresh] = useState<Record<string, api.NewInvite>>({})
  const invited = (id: string) => (made: api.NewInvite) => setFresh(f => ({ ...f, [id]: made }))

  const reload = useCallback(() => api.ownerHouseholds().then(d => { setData(d); setError(undefined) }, e => {
    // (A wrong key: the key page says so.)
    if (e instanceof api.WrongOwnerKey) { setError(api.ownerKey.get() ? e.message : undefined); setNeedKey(true) }
    else setError(errorWords(e))
  }), [])
  useEffect(() => { if (!needKey) reload() }, [needKey, reload])
  // This server's version, and whether a newer one is out: asked once as the page opens, never on a timer
  // (the server sleeps when idle; it asks GitHub at most once an hour anyway). Nothing said if it can't tell.
  const [version, setVersion] = useState<Awaited<ReturnType<typeof api.ownerVersion>>>()
  useEffect(() => { if (!needKey) api.ownerVersion().then(setVersion, () => {}) }, [needKey])

  const save = async (job: Promise<unknown>, done: string) => {
    try { await job; notify(done); await reload() } catch (e) { notify(errorWords(e)); throw e }
  }

  if (needKey) return <KeyPage error={error} onKey={key => { api.ownerKey.set(key); setError(undefined); setNeedKey(false) }} />

  const open = panel?.kind === 'household' ? data?.households.find(h => h.id === panel.id) : undefined
  return (
    <div className="who owner-page" style={{ '--glow': glow } as CSSProperties}>
      <div className="who-aura" aria-hidden />
      <BackButton className="owner-back" />
      {version && <span className="owner-version">Server {version.version}</span>}
      <div className="who-content">
        <img className="setup-mark" src={MARK} alt="" />
        <h1>{data?.server ?? 'Nightcap'}</h1>
        <p className="setup-lead">Every household on this server, and its way in.</p>
        {data && <span className="setup-mode">{data.mode === 'home' ? 'Home server · on your network' : 'Cloud server · joins with a code'}</span>}
        {version?.update && version.latest && <p className="owner-update">Server {version.latest} is available. You're on {version.version}.</p>}
        {error && <p className="setup-error">{error}</p>}
        {error && !data && <button className="btn primary setup-retry" onClick={() => { setError(undefined); reload() }}>Try again</button>}
        {!data && !error && <Waiting after={300} />}
        {data && (
          <>
            <span className="eyebrow owner-count">{count(data.households.length, 'household')}</span>
            <div className="setup-tiles owner-tiles">
              {/* A household: its own colour, how many invites are waiting in the corner, its counts. */}
              {data.households.map((h, i) => {
                const hue = hueOf(h.id)
                return (
                  <button key={h.id} className="setup-tile owner-tile" style={{ '--i': i, '--hue': hue } as CSSProperties}
                    onMouseEnter={() => setGlow(`hsl(${hue} 40% 38%)`)} onFocus={() => setGlow(`hsl(${hue} 40% 38%)`)}
                    onClick={() => setPanel({ kind: 'household', id: h.id })}>
                    <span className="owner-tile-top">
                      <span className="owner-disc"><Icon name="nav_home" size={22} /></span>
                      {h.openInvites > 0 && <span className="owner-tile-left">{count(h.openInvites, 'invite')} waiting</span>}
                    </span>
                    <span className="setup-tile-name">{h.name}</span>
                    <span className="setup-tile-sub">{h.admin ? `Admin profile: ${h.admin.name}` : 'No admin profile yet'}</span>
                    <span className="owner-counts">
                      <span>{count(h.profiles, 'profile')}</span>
                      <span>{count(h.devices, 'device')}</span>
                    </span>
                  </button>
                )
              })}
              {/* An empty slot: dashed, a big plus. */}
              <button className="owner-slot" style={{ '--i': data.households.length } as CSSProperties}
                onMouseEnter={() => setGlow(NEW_GLOW)} onFocus={() => setGlow(NEW_GLOW)} onClick={() => setPanel({ kind: 'new' })}>
                <span className="owner-slot-plus"><Icon name="add" size={30} /></span>
                <b>New household</b>
                <small>With its first profile, the admin</small>
              </button>
            </div>
            {/* What the owner does with the server itself: two slim glass rows under the households. */}
            <div className="owner-actions">
              <button className="owner-tool" onClick={() => setPanel({ kind: 'move' })}>
                <span className="owner-tool-disc"><Icon name="act_move" size={20} /></span>
                <span className="owner-tool-text"><b>Move households</b><small>To or from another server</small></span>
                <span className="owner-tool-go"><Icon name="chevron" size={16} /></span>
              </button>
              <button className="owner-tool" onClick={() => { api.ownerKey.forget(); setData(undefined); setNeedKey(true) }}>
                <span className="owner-tool-disc"><Icon name="act_lock" size={20} /></span>
                <span className="owner-tool-text"><b>Lock owner tools</b><small>Forget the key in this browser</small></span>
                <span className="owner-tool-go"><Icon name="chevron" size={16} /></span>
              </button>
            </div>
          </>
        )}
      </div>

      {panel && (
        <Side title={panel.kind === 'new' ? 'New household' : panel.kind === 'move' ? 'Move households' : open?.name ?? ''}
          hint={panel.kind === 'new' ? 'Its first profile is its admin, who adds the others and sets up its sources.'
            : panel.kind === 'move' ? 'To another Nightcap server: export here, import there. Everything comes along, and TVs carry on once pointed at the new address.'
            : 'A household on this server: its invites, and what you can change.'}
          onClose={() => setPanel(undefined)}>
          {panel.kind === 'move'
            ? <MovePanel households={data?.households ?? []} notify={notify} onImported={() => reload()} />
            : panel.kind === 'new'
            ? <NewHousehold onCreate={(name, admin, invite) => {
                // Opens the new household on its invites, with its first one's code to copy.
                const job = api.ownerCreate(name, admin, invite).then(h => { invited(h.id)(h.invite); return h })
                save(job, `${name} made`).then(() => job.then(h => setPanel({ kind: 'household', id: h.id })), () => {})
              }} />
            : open && <HouseholdPanel h={open} fresh={fresh[open.id]} onInvite={invited(open.id)} save={save} onGone={() => setPanel(undefined)} />}
        </Side>
      )}
      {notice}
    </div>
  )
}

const size = (bytes: number) => (bytes < 1048576 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1048576).toFixed(1)} MB`)
/** A steady hue for a household, from its id. */
const hueOf = (id: string) => [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7)
const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** The owner key, asked once: the Connect screen's look, one field with its button inside. */
function KeyPage({ error, onKey }: { error?: string; onKey: (key: string) => void }) {
  const [key, setKey] = useState('')
  const clean = key.trim()
  return (
    <div className="who" style={{ '--glow': GLOW } as CSSProperties}>
      <div className="who-aura" aria-hidden />
      <BackButton className="owner-back" />
      <div className="who-content">
        <img className="setup-mark" src={MARK} alt="" />
        <h1>Server owner</h1>
        <p className="setup-lead">For whoever runs this server. The owner key was set when it was deployed. It's kept until this tab closes.</p>
        <form className="owner-key" onSubmit={e => { e.preventDefault(); if (clean) onKey(clean) }}>
          <input type="password" value={key} onChange={e => setKey(e.target.value)} placeholder="Owner key" aria-label="Owner key" autoFocus autoComplete="off" />
          <button className="owner-key-go" disabled={!clean} aria-label="Continue"><Icon name="chevron" size={20} /></button>
        </form>
        {error && <p className="setup-error">{error}</p>}
      </div>
    </div>
  )
}

function Side({ title, hint, onClose, children }: { title: string; hint: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])
  return (
    <div className="pn-scrim" onClick={onClose}>
      <aside className="pn" onClick={e => e.stopPropagation()} role="dialog" aria-label={title}>
        <button className="pn-close" aria-label="Close" onClick={onClose}><Icon name="act_close" size={18} /></button>
        <h3>{title}</h3>
        <p className="pn-hint">{hint}</p>
        <div className="pn-scroll">{children}</div>
      </aside>
    </div>
  )
}

/** A household's mark: the house, on a disc. */
const HouseMark = ({ big }: { big?: boolean }) => (
  <span className={`mark${big ? ' big' : ''}`} style={{ '--hue': 250 } as CSSProperties} aria-hidden><Icon name="nav_home" size={big ? 30 : 18} /></span>
)

type Saver = (job: Promise<unknown>, done: string) => Promise<void>

function HouseholdPanel({ h, fresh, onInvite, save, onGone }: {
  h: api.OwnedHousehold; fresh?: api.NewInvite; onInvite: (made: api.NewInvite) => void; save: Saver; onGone: () => void
}) {
  // (A household just made opens on its invites, with its first one's code to copy.)
  const [page, setPage] = useState<'main' | 'invites' | 'rename' | 'admin' | 'delete'>(fresh ? 'invites' : 'main')
  const maker = useMemo(() => api.ownerInvites(h.id), [h.id])
  const back = <Back onClick={() => setPage('main')}>{h.name}</Back>
  const done = () => setPage('main')

  if (page === 'invites') return <div className="pn-items"><Invites maker={maker} fresh={fresh} onMade={onInvite} save={save} parent={{ name: h.name, onBack: () => setPage('main') }} /></div>
  if (page === 'rename') return <div className="pn-items">{back}<NameForm current={h.name} onSave={n => save(api.ownerRename(h.id, n), `Renamed to ${n}`).then(done, () => {})} /></div>
  if (page === 'admin') return <div className="pn-items">{back}<AdminPicker h={h} onPick={p => save(api.ownerSetAdmin(h.id, p.id), `${p.name} is the admin now`).then(done, () => {})} /></div>
  if (page === 'delete') return <div className="pn-items">{back}<DeleteForm h={h} onDelete={() => save(api.ownerDelete(h.id, h.name), `${h.name} deleted`).then(onGone, () => {})} /></div>

  return (
    <div className="pn-items">
      <div className="owner-facts">
        <HouseMark big />
        <span>{h.admin ? <>Admin profile: <b>{h.admin.name}</b></> : 'No admin profile yet'}</span>
        <span>{count(h.profiles, 'profile')} · {count(h.devices, 'device')} · since {new Date(h.created).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}</span>
      </div>

      <h4 className="pn-sub">Invites</h4>
      <Pill icon="add" sub={h.openInvites ? `${count(h.openInvites, 'invite')} waiting · one device each` : 'One device each, within 24 hours'} onClick={() => setPage('invites')}>Invite a device</Pill>

      <h4 className="pn-sub">Change</h4>
      <Pill icon="act_unwatched" sub={h.admin ? `Now ${h.admin.name}: pick another of its profiles` : 'Pick one of its profiles'} onClick={() => setPage('admin')}>Change the admin</Pill>
      <Pill icon="act_rate" sub={`Now “${h.name}”`} onClick={() => setPage('rename')}>Rename the household</Pill>
      <Pill icon="act_later" sub={h.admin ? `If ${h.admin.name} has forgotten it: they set a new one next time` : "If it's been forgotten"}
        onClick={() => save(api.ownerResetPin(h.id), 'Admin PIN reset').catch(() => {})}>Reset the admin PIN</Pill>
      <Pill icon="act_remove" danger sub="Everything in it goes, and its devices stop" onClick={() => setPage('delete')}>Delete the household</Pill>
    </div>
  )
}

function NewHousehold({ onCreate }: { onCreate: (name: string, admin: string, invite: string) => void }) {
  const lim = useLimitsReady()
  const [name, setName] = useState('')
  const [admin, setAdmin] = useState('')
  const [invite, setInvite] = useState('')
  const ok = name.trim() && admin.trim() && invite.trim()
  return (
    <form className="pn-form" onSubmit={e => { e.preventDefault(); if (ok) onCreate(name.trim(), admin.trim(), invite.trim()) }}>
      <h4 className="pn-sub">Its name</h4>
      <input className="pn-input" value={name} onChange={e => setName(e.target.value)} placeholder="The Smiths" maxLength={lim.names.household} autoFocus aria-label="Household name" />
      <h4 className="pn-sub">Its admin profile</h4>
      <input className="pn-input" value={admin} onChange={e => setAdmin(e.target.value)} placeholder="Who looks after it" maxLength={lim.names.profile} aria-label="Admin profile name" />
      <h4 className="pn-sub">Its first device</h4>
      <input className="pn-input" value={invite} onChange={e => setInvite(e.target.value)} placeholder="Living room TV" maxLength={lim.names.inviteLabel} aria-label="First device's name" />
      <div className="pn-buttons"><button className="btn primary" disabled={!ok}>Make it</button></div>
      <p className="pn-note">Then copy its invite for that device: it joins with that name.</p>
    </form>
  )
}

function NameForm({ current, onSave }: { current: string; onSave: (name: string) => void }) {
  const lim = useLimitsReady()
  const [name, setName] = useState(current)
  const clean = name.trim()
  return (
    <form className="pn-form" onSubmit={e => { e.preventDefault(); if (clean && clean !== current) onSave(clean) }}>
      <h4 className="pn-sub">Name</h4>
      <input className="pn-input" value={name} onChange={e => setName(e.target.value)} maxLength={lim.names.household} autoFocus aria-label="Household name" />
      <div className="pn-buttons"><button className="btn primary" disabled={!clean || clean === current}>Save</button></div>
    </form>
  )
}

function AdminPicker({ h, onPick }: { h: api.OwnedHousehold; onPick: (p: Profile) => void }) {
  const [list, setList] = useState<Profile[]>()
  const [failed, setFailed] = useState(false)
  const load = useCallback(() => { setFailed(false); api.ownerProfiles(h.id).then(setList, () => setFailed(true)) }, [h.id])
  useEffect(load, [load])
  return (
    <>
      <h4 className="pn-sub">Admin</h4>
      <p className="pn-note top">The admin adds and removes profiles and sets up the household's sources. The one before stops being admin.</p>
      {failed && !list ? <><p className="pn-current">{WORDS.offline}</p><button className="btn" onClick={load}>Try again</button></>
        : !list ? <p className="pn-current">Loading…</p> : list.map(p => {
        const a = avatarOf(p.avatar, p.id)
        return (
          <button key={p.id} className={`pn-item row-item${p.isAdmin ? ' on' : ''}`} onClick={() => !p.isAdmin && onPick(p)}>
            <span className="st-face" style={{ '--tint': a.tint } as CSSProperties}><img src={avatarSrc(a.image)} alt="" /></span>
            <span className="pn-label"><b>{p.name}</b><small>{p.isAdmin ? 'The admin' : 'Make admin'}</small></span>
            {p.isAdmin && <Icon name="check" size={16} />}
          </button>
        )
      })}
    </>
  )
}

function DeleteForm({ h, onDelete }: { h: api.OwnedHousehold; onDelete: () => void }) {
  const [typed, setTyped] = useState('')
  const ok = typed.trim() === h.name
  return (
    <form className="pn-form" onSubmit={e => { e.preventDefault(); if (ok) onDelete() }}>
      <h4 className="pn-sub">Delete</h4>
      <p className="pn-current">All of {h.name} goes: its profiles, what they watched, its sources. Its {count(h.devices, 'device')} stop working at once. This can't be undone.</p>
      <input className="pn-input" value={typed} onChange={e => setTyped(e.target.value)} placeholder={`Type ${h.name} to confirm`} aria-label="Household name, to confirm" autoComplete="off" />
      <div className="pn-buttons"><button className="btn danger owner-delete" disabled={!ok}>Delete {h.name}</button></div>
    </form>
  )
}

// ---------- Moving households to another server ----------

function MovePanel({ households, notify, onImported }: { households: api.OwnedHousehold[]; notify: (m: string) => void; onImported: () => void }) {
  const [side, setSide] = useState<'export' | 'import'>('export')
  return (
    <div className="pn-items">
      <div className="st-tabs owner-move-tabs" role="tablist">
        <button role="tab" aria-selected={side === 'export'} className={side === 'export' ? 'on' : ''} onClick={() => setSide('export')}>Export from here</button>
        <button role="tab" aria-selected={side === 'import'} className={side === 'import' ? 'on' : ''} onClick={() => setSide('import')}>Import here</button>
      </div>
      {side === 'export' ? <ExportForm households={households} notify={notify} /> : <ImportForm onImported={onImported} />}
    </div>
  )
}

function ExportForm({ households, notify }: { households: api.OwnedHousehold[]; notify: (m: string) => void }) {
  const lim = useLimitsReady()
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(households.map(h => h.id)))
  const [password, setPassword] = useState('')
  const [again, setAgain] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const every = chosen.size === households.length
  const ok = chosen.size > 0 && password.length >= lim.exportPasswordMin && password === again
  const toggle = (id: string) => setChosen(c => { const n = new Set(c); if (n.has(id)) n.delete(id); else n.add(id); return n })

  const go = async () => {
    setBusy(true); setError(undefined)
    try {
      const { blob, name } = await api.ownerExport(every ? null : [...chosen], password)
      // Saved as a file: the link is clicked for you, then let go.
      const url = URL.createObjectURL(blob)
      const a = Object.assign(document.createElement('a'), { href: url, download: name })
      document.body.appendChild(a); a.click(); a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
      notify(`Saved ${name}`)
      setPassword(''); setAgain('')
    } catch (e) { setError(errorWords(e)) } finally { setBusy(false) }
  }

  return (
    <form className="pn-form" onSubmit={e => { e.preventDefault(); if (ok) go() }}>
      <h4 className="pn-sub">Households</h4>
      {households.map(h => (
        <button type="button" key={h.id} className={`pn-item${chosen.has(h.id) ? ' on' : ''}`} role="switch" aria-checked={chosen.has(h.id)} onClick={() => toggle(h.id)}>
          <span className="pn-tick">{chosen.has(h.id) ? <Icon name="check" size={14} /> : null}</span>
          <span className="pn-label"><b>{h.name}</b><small>{count(h.profiles, 'profile')} · {count(h.devices, 'device')}</small></span>
        </button>
      ))}
      <h4 className="pn-sub">A password for the file</h4>
      <input className="pn-input" type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="At least 8 characters" autoComplete="new-password" aria-label="Password" />
      <input className="pn-input" type="password" value={again} onChange={e => setAgain(e.target.value)} placeholder="The same again" autoComplete="new-password" aria-label="Password again" />
      <p className={`pn-test${password && again && password !== again ? ' bad' : ''}`}>
        {password && again && password !== again ? "The two don't match." : "The file holds everything, the sources and keys too, locked with this. Without it, it can't be opened."}
      </p>
      {error && <p className="pn-test bad">{error}</p>}
      <div className="pn-buttons">
        <button className="btn primary" disabled={!ok || busy}>{busy ? 'Exporting…' : every ? 'Export every household' : `Export ${count(chosen.size, 'household')}`}</button>
      </div>
    </form>
  )
}

function ImportForm({ onImported }: { onImported: () => void }) {
  const lim = useLimitsReady()
  const importMax = api.importMaxFileBytes(lim.maxImportBytes)
  const [file, setFile] = useState<File>()
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  // First the file is checked (nothing changes): its households, new or already here. Each one already
  // here is skipped unless picked to be replaced.
  const [found, setFound] = useState<api.InFile[]>()
  const [replace, setReplace] = useState<Set<string>>(new Set())
  const [done, setDone] = useState<api.Imported[]>()

  const run = async (job: () => Promise<void>) => {
    setBusy(true); setError(undefined)
    try { await job() } catch (e) { setError(errorWords(e)) } finally { setBusy(false) }
  }
  const check = () => run(async () => {
    if (!file) return
    setFound(await api.ownerImport(file, password, { check: true }))
    setReplace(new Set())
  })
  const go = () => run(async () => {
    if (!file) return
    setDone(await api.ownerImport(file, password, { replace: [...replace] }))
    setFile(undefined); setPassword(''); setFound(undefined)
    onImported()
  })
  const flip = (id: string) => setReplace(r => { const n = new Set(r); if (n.has(id)) n.delete(id); else n.add(id); return n })

  if (done) {
    const brought = done.filter(h => h.status !== 'skipped').length
    return (
      <div className="pn-items">
        <div className="pot-status good owner-done"><span className="pot-icon">✓</span><b>{count(brought, 'household')} moved in</b></div>
        {done.map(h => (
          <div key={h.id} className="pn-item static"><span className="pn-tick"><Icon name="nav_home" size={16} /></span>
            <span className="pn-label"><b>{h.name}</b>
              <small>{h.status === 'skipped' ? 'Skipped: left as it was here' : `${h.status === 'replaced' ? 'Replaced' : 'Added'} · ${count(h.profiles, 'profile')} · ${count(h.devices, 'device')}`}</small></span></div>
        ))}
        <p className="pn-note">On each TV, change the server to this one on its Connect screen (Settings, the Nightcap server link): no joining again. A household may need a new invite here.</p>
        <div className="pn-buttons"><button className="btn" onClick={() => setDone(undefined)}>Import another</button></div>
      </div>
    )
  }

  if (found && file) {
    const replacing = found.filter(h => h.here && replace.has(h.id)).length
    const adding = found.filter(h => !h.here).length
    return (
      <div className="pn-form">
        <h4 className="pn-sub">In {file.name}</h4>
        {found.map(h => h.here ? (
          <button type="button" key={h.id} className={`pn-item${replace.has(h.id) ? ' on' : ''}`} role="switch" aria-checked={replace.has(h.id)} onClick={() => flip(h.id)}>
            <span className="pn-tick">{replace.has(h.id) ? <Icon name="check" size={14} /> : null}</span>
            <span className="pn-label"><b>{h.name}{h.nameHere && h.nameHere !== h.name ? <span className="owner-here"> · here: {h.nameHere}</span> : null}</b>
              <small>{replace.has(h.id) ? `Replace: ${h.nameHere ?? 'the one here'} is deleted and put back as the file has it` : 'Already here: skip it (tap to replace)'}</small></span>
          </button>
        ) : (
          <div key={h.id} className="pn-item static">
            <span className="pn-tick"><Icon name="add" size={14} /></span>
            <span className="pn-label"><b>{h.name}</b><small>New: will be added · {count(h.profiles, 'profile')} · {count(h.devices, 'device')}</small></span>
          </div>
        ))}
        {error && <p className="pn-test bad">{error}</p>}
        <div className="pn-buttons">
          <button className="btn primary" disabled={busy || adding + replacing === 0} onClick={go}>
            {busy ? 'Importing…' : adding + replacing === 0 ? 'Nothing to import' : replacing ? `Import and replace ${count(replacing, 'household')}` : 'Import'}
          </button>
          <button className="btn" disabled={busy} onClick={() => setFound(undefined)}>Back</button>
        </div>
        {found.some(h => h.here) && <p className="pn-note">Replacing loses what that household has here now. A name here that differs from the file's can mean an edited file: only replace with a file you exported yourself.</p>}
      </div>
    )
  }

  return (
    <form className="pn-form" onSubmit={e => { e.preventDefault(); if (file && password) check() }}>
      <h4 className="pn-sub">The exported file</h4>
      <label className="owner-file">
        <input type="file" accept=".nightcap" onChange={e => setFile(e.target.files?.[0])} />
        <span className="mark" aria-hidden><Icon name="add" size={16} /></span>
        <span className="pn-label"><b>{file ? file.name : 'Choose a .nightcap file'}</b><small className={file && file.size > importMax ? 'owner-too-big' : ''}>
          {file ? `${size(file.size)}${file.size > importMax ? `: too big (up to about ${Math.floor(importMax / 1048576)} MB)` : ''}` : 'Exported from the other server'}</small></span>
      </label>
      <h4 className="pn-sub">Its password</h4>
      <input className="pn-input" type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="The one it was exported with" autoComplete="off" aria-label="Password" />
      {error && <p className="pn-test bad">{error}</p>}
      <div className="pn-buttons"><button className="btn primary" disabled={!file || !password || busy || file.size > importMax}>{busy ? 'Opening…' : 'Next'}</button></div>
      <p className="pn-note">Next shows what's in it, and nothing changes yet: new households are added, and for each one already here you choose to replace it or leave it.</p>
    </form>
  )
}

/** (It waits for the server's limits: names, the PIN, how many.) */
export default function Owner() {
  return <WithLimits><OwnerScreen /></WithLimits>
}
