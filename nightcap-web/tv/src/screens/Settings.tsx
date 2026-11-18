import { useEffect, useRef, useState, type ReactNode } from 'react'
import { QUALITIES, ROW_NATIVE, SAMPLE } from '../../../src/languages'
import * as admin from '../admin'
import * as api from '../api'
import { focus as focusEl, focusFirst } from '../focus'
import { useKeys, useNav, useOnFront } from '../nav'
import * as prefs from '../player/prefs'
import * as profiles from '../profiles'
import { AVATARS } from '../profiles'
import Aura from '../ui/Aura'
import AvatarCarousel from '../ui/AvatarCarousel'
import Icon from '../ui/Icon'
import { notify } from '../ui/Notice'
import Connect from './Connect'
import './Settings.css'
import * as keyboard from '../keyboard'
import { useLimitsReady } from '../../../src/limits'

/** The app's version, the same as the Android TV app's. */
const APP_VERSION = '1.0'
import WithLimits from '../ui/WithLimits'

// Settings: who you are, then cards for audio, subtitles,
// quality, language rows, the Top 10, Home's widgets and (the admin) the AI's spend; each opens a
// panel from the right with a preview. Changes show at once and are saved in order. Unlike the
// Android TV, a panel keeps focus inside it, and Settings reloads each time it's back in
// front. (The Android TV's "TV settings" link opens the system's settings: a web app on
// Samsung or LG can't, so it's left out.)

type ProfilePage = {
  id: string; name: string; avatar: string | null; isAdmin: boolean
  settings: { quality?: string; languages?: string[]; top10_countries?: string[]; show_weather?: boolean; show_ai?: boolean; audio_language?: string; subtitles?: string }
  still?: string | null
  weatherCity?: string | null
  usage?: {
    month_cost: number; month_calls: number; today_cost: number; by_profile?: { name: string; cost: number; calls: number; unpriced?: number }[]
    /** Calls to a model without a price: their cost isn't in the totals. */
    month_unpriced_calls?: number; today_unpriced_calls?: number
  } | null
  /** Whether the household has the AI (it's optional): without it, nothing about the AI shows. A
   * server that doesn't say is taken to have it. */
  aiAvailable?: boolean
  options?: { languages?: { code: string; name: string }[]; countries?: { code: string; name: string }[] }
}

type Panel = 'audio' | 'subtitles' | 'quality' | 'rows' | 'top10' | 'home' | 'ai'

const GLYPHS: Record<string, string> = { hin: 'अ आ', jpn: 'あア', kor: '가나', chi: '中文', ara: 'أ ب', rus: 'Аа', tam: 'அ ஆ', tel: 'అ ఆ', pan: 'ਅ ਆ', urd: 'ا ب' }
const BADGE: Record<string, string> = { best: 'UHD', '4K': '4K', '1080p': 'HD', '720p': 'HD' }
const BLUR: Record<string, number> = { best: 0, '4K': 0, '1080p': 0.8, '720p': 2 }
const ROW_ENGLISH: Record<string, string> = {
  hi: 'Hindi', ko: 'Korean', anime: 'Japanese animation, and anime from elsewhere', ja: 'Japanese', ta: 'Tamil', te: 'Telugu',
  ml: 'Malayalam', es: 'Spanish', fr: 'French', tr: 'Turkish', zh: 'Chinese',
}
const DEFAULT_ROWS = Object.keys(ROW_NATIVE)

const money = (n: number) => (!(n >= 0) || (n > 0 && n < 0.01) ? 'under 1¢' : `$${n.toFixed(2)}`)
/** [usd], or "$0.42+" / "Cost unknown" when [unpriced] calls were to a model without a price (as the Android TV's). */
const cost = (usd: number, unpriced = 0) => (!unpriced ? money(usd) : usd === 0 ? 'Cost unknown' : `${money(usd)}+`)
const countryName = (name: string) => name.replace(/^the /, '').replace(/^./, c => c.toUpperCase())

function SettingsScreen() {
  const lim = useLimitsReady()
  const nav = useNav()
  const me = profiles.current()
  const [page, setPage] = useState<ProfilePage | null>(null)
  const [panel, setPanel] = useState<Panel | null>(null)
  const [editing, setEditing] = useState(false)
  const [, redraw] = useState(0)
  const profileCard = useRef<HTMLButtonElement>(null)
  const opener = useRef<HTMLElement | null>(null)
  const queue = useRef(Promise.resolve())

  // The page, and again each time Settings is back in front.
  const loadFailed = useRef(false)
  const load = () => api.call<ProfilePage>('/launcher/profile.json').then(
    pg => { loadFailed.current = false; setPage(pg) },
    () => { loadFailed.current = true })
  useOnFront(() => { load() })
  useEffect(() => { focusEl(profileCard.current) }, [])

  // What's shown before (or without) the server's answer: the kept profile and this TV's choices.
  const p: ProfilePage = page ?? { id: me?.id ?? '', name: me?.name ?? '', avatar: me?.avatar ?? null, isAdmin: me?.isAdmin ?? false, settings: {} }
  const set = p.settings
  const a = profiles.avatar(p)
  const audio = prefs.audio()
  const subs = prefs.subtitles()
  const quality = QUALITIES.find(q => q.key === set.quality) ?? QUALITIES[0]
  const rows = set.languages ?? []
  const countries = page?.options?.countries ?? []
  const top10 = set.top10_countries?.[0]
  const top10Name = top10 ? countryName(countries.find(c => c.code === top10)?.name ?? top10) : ''
  const weatherOn = set.show_weather !== false
  const aiOn = set.show_ai ?? p.isAdmin

  /** Saved in order; shown at once. Another profile than the one watching needs the PIN. */
  const save = (change: Record<string, unknown>, after?: () => void, onFail?: (msg: string) => void) => {
    setPage(pg => pg && {
      ...pg,
      ...(change.name ? { name: change.name as string } : {}),
      ...('avatar' in change ? { avatar: change.avatar as string } : {}),
      settings: { ...pg.settings, ...((change.settings as object) ?? {}) },
    })
    queue.current = queue.current.then(async () => {
      if (p.id && p.id !== profiles.currentId() && !(await admin.ensure())) return
      try {
        await api.post('/launcher/profile', { ...change, id: p.id })
        await profiles.fetchList()
        after?.()
      } catch (e) {
        const msg = e instanceof api.ServerError && e.status === 400 && e.message ? e.message : "Couldn't save that. Try again."
        if (onFail) onFail(msg)
        else notify("Couldn't save that. Try again.")
      }
    })
  }

  /** Whether this profile's settings have come from the server. Until they have, the cards kept there
   * don't open: a change made to the defaults would overwrite what's saved. (Audio and subtitles are the
   * TV's own.) */
  const loaded = () => {
    if (page) return true
    notify(loadFailed.current ? "Couldn't load your settings. Check the connection." : 'Still loading your settings…')
    if (loadFailed.current) { loadFailed.current = false; load() }
    return false
  }
  const open = (which: Panel) => {
    if (which !== 'audio' && which !== 'subtitles' && !loaded()) return
    opener.current = document.activeElement as HTMLElement
    setPanel(which)
  }
  const close = () => {
    setPanel(null)
    setTimeout(() => focusEl(opener.current), 0)
  }

  // Back: a panel or the editor first; else Settings closes.
  useKeys(key => {
    if (editing) return
    if (panel) {
      if (key === 'back') { close(); return true }
      if (key === 'left' || key === 'right') return true
    }
  })

  const card = (key: string, label: string, body: ReactNode, onClick: () => void, cls = '') => (
    <button key={key} className={`set-card ${cls}`} data-f="" onClick={onClick}>
      <span className="eyebrow">{label}</span>
      {body}
    </button>
  )

  return (
    <div className="settings">
      <Aura tint={a.tint} />
      <div className={`set-body${panel ? ' behind' : ''}${editing ? ' hidden-for-editor' : ''}`} data-inert={panel || editing ? '' : undefined}>
        <span className="eyebrow corner-eyebrow">Settings</span>
        {/* Which version of the app this is, small in the corner (as the Android TV's Settings). */}
        <span className="set-version">Nightcap {APP_VERSION}</span>
        <div className="set-cards">
          <button ref={profileCard} className="set-card set-profile" data-f="" data-autofocus="" onClick={() => { if (loaded()) setEditing(true) }}>
            <span className="set-disc" style={{ background: a.tint }}><img src={profiles.avatarSrc(a.image)} alt="" /></span>
            <b className="set-name">{p.name}</b>
            <span className="set-role">{p.isAdmin ? 'Admin profile' : 'Profile'}</span>
            <span className="set-edit">Avatar and name ›</span>
          </button>
          <div className="set-grid">
            {card('audio', 'Audio', <>
              <Icon name="waveform" size={24} className="set-corner-icon" />
              <span className="set-big">{lim.audioLanguages.find(l => l.name === audio)?.native ?? audio}</span>
              <span className="set-small">{audio} versions first</span>
            </>, () => open('audio'))}
            {card('subtitles', 'Subtitles', <>
              <span className={`set-caption${subs === 'off' ? ' off' : ''}`}>{subs === 'off' ? 'Off' : GLYPHS[subs] ?? 'Aa'}</span>
              <span className="set-small">{subs === 'off' ? 'No subtitles' : prefs.nameOf(subs) ?? subs}</span>
            </>, () => open('subtitles'))}
            {card('quality', 'Quality', <>
              <span className="set-badge">{BADGE[quality.key]}</span>
              <span className="set-huge">{quality.title}</span>
              <span className="set-small">{quality.short}</span>
            </>, () => open('quality'))}
            {card('rows', 'Language rows', <>
              <span className="set-chips">{rows.slice(0, 8).map(c => <span key={c} className="set-chip">{ROW_NATIVE[c] ?? c}</span>)}</span>
              <span className="set-small">{rows.length === 0 ? 'None: Home sticks to English' : rows.length === 1 ? '1 row'
                : rows.length > 8 ? `${rows.length} rows · +${rows.length - 8} more` : `${rows.length} rows`}</span>
            </>, () => open('rows'), 'wide')}
            {card('top10', 'Top 10', <>
              <span className="set-ten" aria-hidden>10</span>
              <span className="set-big">{top10Name}</span>
            </>, () => open('top10'))}
            {card('home', 'Home screen', <>
              <span className={`set-toggle${weatherOn ? ' on' : ''}`}>{weatherOn ? '●' : '○'}  Weather</span>
              {page?.aiAvailable !== false && <span className={`set-toggle${aiOn ? ' on' : ''}`}>{aiOn ? '●' : '○'}  AI cost</span>}
            </>, () => open('home'), 'short')}
            {page?.usage && card('ai', 'AI this month', <>
              <span className="set-big">{cost(page.usage.month_cost, page.usage.month_unpriced_calls)}</span>
              <span className="set-small">{page.usage.month_calls} {page.usage.month_calls === 1 ? 'request' : 'requests'} · {cost(page.usage.today_cost, page.usage.today_unpriced_calls)} today</span>
            </>, () => open('ai'), 'short')}
          </div>
        </div>
        <button className="set-link" data-f="" onClick={() => nav.push(<Connect />)}>Nightcap server · {location.host} <Icon name="chevron" size={12} /></button>
      </div>

      {panel && (
        <SidePanel which={panel} page={p} countries={countries} onClose={close}
          onAudio={name => { prefs.saveAudio(name); redraw(n => n + 1); close() }}
          onSubtitles={code => { prefs.saveSubtitles(code); redraw(n => n + 1); close() }}
          onQuality={key => { save({ settings: { quality: key } }); close() }}
          onRows={list => save({ settings: { languages: list } })}
          onTop10={code => { save({ settings: { top10_countries: [code, ...(set.top10_countries ?? []).filter(c => c !== code)] } }); close() }}
          onToggle={(k, v) => save({ settings: { [k]: v } })} />
      )}

      {editing && (
        <Editor profile={p} onClose={() => { setEditing(false); setTimeout(() => focusEl(profileCard.current), 0) }}
          onAvatar={key => save({ avatar: key })}
          onName={(name, revert) => save({ name }, undefined, msg => { notify(msg); revert() })} />
      )}
    </div>
  )
}

// ---------- The panels ----------

function SidePanel({ which, page, countries, onClose, onAudio, onSubtitles, onQuality, onRows, onTop10, onToggle }: {
  which: Panel; page: ProfilePage; countries: { code: string; name: string }[]; onClose: () => void
  onAudio: (name: string) => void; onSubtitles: (code: string) => void; onQuality: (key: string) => void
  onRows: (list: string[]) => void; onTop10: (code: string) => void; onToggle: (key: 'show_weather' | 'show_ai', on: boolean) => void
}) {
  const lim = useLimitsReady()
  const set = page.settings
  const list = useRef<HTMLDivElement>(null)
  const [focused, setFocused] = useState<string | null>(null)
  const [rows, setRows] = useState(set.languages ?? [])

  type Item = { key: string; name: string; sub?: string; chosen?: boolean; run?: () => void }
  let title = '', hint = '', items: Item[] = [], startOnChosen = true, preview: ReactNode = null
  if (which === 'audio') {
    title = 'Audio'
    hint = 'Versions in this language come first, dubbed ones too, and inside a film this track plays.'
    items = lim.audioLanguages.map(l => ({ key: l.name, name: l.native, sub: l.native !== l.name ? l.name : undefined, chosen: prefs.audio() === l.name, run: () => onAudio(l.name) }))
  } else if (which === 'subtitles') {
    title = 'Subtitles'
    hint = 'Shown when there are subtitles in this language.'
    items = [{ key: 'off', name: 'Off', sub: 'No subtitles', chosen: prefs.subtitles() === 'off', run: () => onSubtitles('off') },
      ...lim.audioLanguages.map(l => ({ key: l.code, name: l.native, sub: l.native !== l.name ? l.name : undefined, chosen: prefs.subtitles() === l.code, run: () => onSubtitles(l.code) }))]
    const line = focused && focused !== 'off' ? SAMPLE[focused] ?? '' : ''
    preview = <Still src={page.still}><span key={focused ?? ''} className="set-sample">{line}</span></Still>
  } else if (which === 'quality') {
    title = 'Quality'
    hint = "Versions in this quality come first. If there isn't one, the next one up, then down."
    items = QUALITIES.map(q => ({ key: q.key, name: q.title, sub: q.detail, chosen: (set.quality ?? 'best') === q.key, run: () => onQuality(q.key) }))
    const q = QUALITIES.find(x => x.key === focused) ?? QUALITIES[0]
    preview = <Still src={page.still} blur={BLUR[q.key]}><span className="set-badge preview">{BADGE[q.key]}</span><span className="set-data">{q.data}</span></Still>
  } else if (which === 'rows') {
    title = 'Language rows'
    hint = "Each one gets its own Latest shows and movies rows on Home. Tick as many as you like."
    startOnChosen = false
    const codes = page.options?.languages?.map(l => l.code) ?? DEFAULT_ROWS
    items = codes.map(c => ({
      key: c, name: ROW_NATIVE[c] ?? c, sub: ROW_ENGLISH[c], chosen: rows.includes(c),
      run: () => { const next = rows.includes(c) ? rows.filter(x => x !== c) : [...rows, c]; setRows(next); onRows(next) },
    }))
    preview = <Posters keyName={focused ? `lang:${focused}` : null} neighbours={codes.map(c => `lang:${c}`)} />
  } else if (which === 'top10') {
    title = 'Top 10'
    hint = "Which country's Top 10 shows and movies are on Home."
    items = countries.map(c => ({ key: c.code, name: countryName(c.name), chosen: set.top10_countries?.[0] === c.code, run: () => onTop10(c.code) }))
    preview = <Posters keyName={focused ? `top10:${focused}` : null} neighbours={countries.map(c => `top10:${c.code}`)} ranked />
  } else if (which === 'home') {
    title = 'Home screen'
    hint = 'What shows on Home for this profile.'
    startOnChosen = false
    const weather = set.show_weather !== false, ai = set.show_ai ?? page.isAdmin
    items = [
      { key: 'w', name: 'Weather', sub: page.weatherCity ? `Top right · ${page.weatherCity}` : 'Top right', chosen: weather, run: () => onToggle('show_weather', !weather) },
      ...(page.aiAvailable !== false ? [{ key: 'a', name: 'AI cost', sub: "This month's spend, bottom right", chosen: ai, run: () => onToggle('show_ai', !ai) }] : []),
    ]
  } else {
    title = 'AI this month'
    hint = "Picks, reasons and search. Each profile's share of the month."
    startOnChosen = false
    const u = page.usage
    items = u ? [
      { key: 'all', name: 'All profiles', sub: `${cost(u.month_cost, u.month_unpriced_calls)} · ${u.month_calls} requests · ${cost(u.today_cost, u.today_unpriced_calls)} today` },
      ...(u.by_profile ?? []).map((x, i) => ({ key: `p${i}`, name: x.name, sub: `${cost(x.cost, x.unpriced)} · ${x.calls} requests` })),
    ] : []
  }

  // Focus: the chosen row (or the first); the list keeps the focused row in its middle.
  useEffect(() => {
    const el = list.current
    if (!el) return
    el.scrollTop = 0
    const target = (startOnChosen && el.querySelector<HTMLElement>('[data-chosen]')) || el.querySelector<HTMLElement>('[data-f]')
    focusEl(target)
    if (!target) focusFirst()
  }, [])
  const centre = (el: HTMLElement) => {
    const l = list.current
    if (l) l.scrollTop = Math.max(0, el.offsetTop - l.clientHeight / 2 + el.clientHeight / 2)
  }

  return (
    <div className="set-scrim">
      <div className="set-panel" data-scope="" role="dialog" aria-label={title}>
        <b className="set-panel-title">{title}</b>
        <p className="set-panel-hint">{hint}</p>
        {preview && <div className="set-preview">{preview}</div>}
        <div ref={list} className="set-list">
          {items.length === 0 && <p className="set-panel-hint">Loading…</p>}
          {items.map(it => (
            <button key={it.key} className="set-choice" data-f="" data-chosen={it.chosen ? '' : undefined}
              onFocus={e => { setFocused(it.key); centre(e.currentTarget) }} onClick={() => (it.run ? it.run() : undefined)}>
              <span className="set-choice-text"><b>{it.name}</b>{it.sub && <small>{it.sub}</small>}</span>
              <span className={`set-tick${it.chosen ? ' on' : ''}`}><Icon name="check" size={16} /></span>
            </button>
          ))}
        </div>
      </div>
      {/* (Closing is Back, handled by Settings; a click on the scrim too.) */}
      <span className="set-scrim-close" onClick={onClose} />
    </div>
  )
}

/** The preview frame: what you're watching (or today's featured title), as on Android. */
function Still({ src, blur = 0, children }: { src?: string | null; blur?: number; children?: ReactNode }) {
  return (
    <span className="set-still">
      {src && <img key={src} src={src} alt="" style={{ filter: blur ? `blur(${blur}rem)` : undefined }} />}
      <span className="set-still-shade" />
      {children}
    </span>
  )
}

/** Six posters for a language row or a country's Top 10: fetched 140 ms after focus rests,
 * the neighbours ahead; kept for the screen's life. */
const posterCache = new Map<string, string[]>()
function Posters({ keyName, neighbours, ranked }: { keyName: string | null; neighbours: string[]; ranked?: boolean }) {
  const [posters, setPosters] = useState<string[]>([])
  const get = (k: string) => {
    const kept = posterCache.get(k)
    if (kept) return Promise.resolve(kept)
    return api.call<{ posters?: string[] }>(`/launcher/preview/${k}.json`).then(r => {
      const list = (r.posters ?? []).slice(0, 6)
      if (list.length) { posterCache.set(k, list); list.forEach(u => { new Image().src = u }) }
      return list
    })
  }
  useEffect(() => {
    if (!keyName) return
    const at = neighbours.indexOf(keyName)
    for (const d of [1, 2, -1]) { const n = neighbours[at + d]; if (n) get(n).catch(() => {}) }
    const t = setTimeout(() => get(keyName).then(list => setPosters(list), () => setPosters([])), 140)
    return () => clearTimeout(t)
  }, [keyName])
  return (
    <span className={`set-posters${ranked ? ' ranked' : ''}`}>
      {Array.from({ length: 6 }, (_, i) => (
        <span key={i} className="set-poster" style={{ animationDelay: `${35 * i}ms` }}>
          {posters[i] && <img key={posters[i]} src={posters[i]} alt="" />}
          {ranked && <b>{i + 1}</b>}
        </span>
      ))}
    </span>
  )
}

// ---------- The editor ----------

function Editor({ profile, onClose, onAvatar, onName }: {
  profile: ProfilePage; onClose: () => void; onAvatar: (key: string) => void; onName: (name: string, revert: () => void) => void
}) {
  const lim = useLimitsReady()
  const start = Math.max(0, AVATARS.findIndex(x => x.key === profiles.avatar(profile).key))
  const [index, setIndex] = useState(start)
  const [name, setName] = useState(profile.name)
  const [typing, setTyping] = useState(false)
  const [draft, setDraft] = useState(profile.name)
  const carousel = useRef<HTMLDivElement>(null)
  const field = useRef<HTMLInputElement>(null)
  const av = AVATARS[index]
  const label = av.key === 'invader' ? 'Space invader' : av.key.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase())

  useEffect(() => { focusFirst(carousel.current) }, [])
  useEffect(() => { if (typing) { focusEl(field.current); field.current?.setSelectionRange(draft.length, draft.length) } }, [typing])

  const keepAvatar = () => {
    if (av.key !== profile.avatar) onAvatar(av.key)
    onClose()
  }
  const doneTyping = () => {
    const clean = draft.trim().replace(/\s+/g, ' ')
    if (!clean) { notify('A name needs at least one letter'); return }
    if (clean !== name) {
      const was = name
      setName(clean)
      onName(clean, () => setName(was))
    }
    setTyping(false)
    setTimeout(() => focusFirst(carousel.current), 0)
  }

  useKeys((key, e) => {
    if (typing) {
      if (key === 'back') { setTyping(false); setDraft(name); setTimeout(() => focusFirst(carousel.current), 0); return true }
      // (OK in the field with the keyboard closed opens it again.)
      if (key === 'ok' && document.activeElement === field.current && !keyboard.typing()) return
      if (key === 'ok') { e.preventDefault(); doneTyping(); return true }
      return
    }
    if (key === 'back') { onClose(); return true }
  })

  return (
    <div className="set-editor" data-scope="">
      <span className="eyebrow set-editor-eyebrow">Choose your avatar</span>
      <div ref={carousel} className="set-editor-carousel">
        <AvatarCarousel value={index} onChange={setIndex} onPick={keepAvatar} />
      </div>
      <b className="set-editor-name">{name}</b>
      <span className="set-editor-label">{label}</span>
      {typing ? (
        <input ref={field} className="field set-editor-field" data-f="" value={draft} maxLength={lim.names.profile} autoCapitalize="words" autoComplete="off"
          spellCheck={false} onChange={e => setDraft(e.target.value)} />
      ) : (
        <button className="pill set-editor-rename" data-f="" onClick={() => { setDraft(name); setTyping(true) }}>Change name</button>
      )}
      <span className="set-editor-help">Left and right to choose · OK to keep · Back to cancel</span>
    </div>
  )
}

/** (It waits for the server's limits: names, the PIN, how many.) */
export default function Settings() {
  return <WithLimits><SettingsScreen /></WithLimits>
}
