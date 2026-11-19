// Every call to the Nightcap server goes through here, so login (a cookie or token) can be
// added in one place later. Paths are relative: the app works wherever the server serves it.
//
// The server needs to know whose request it is. This browser joins a household once, like a TV
// (POST /join), and sends the key it gets in X-Device-Key on every request; then X-Profile names
// who's watching. A key the server no longer knows (401, X-Join-Again) means joining again.

import { limits } from './limits'
import type { Card, Feed, Item, Page, Play, Profile } from './types'
import { linkPath } from './player/link'
import { ApiError, offline, Said, type Body } from './errors'
import { forgetKept } from './kept'

function stored(key: string, fallback?: string) {
  return {
    get: () => localStorage.getItem(key) ?? fallback ?? null,
    set: (id: string) => { localStorage.setItem(key, id); changed() },
    forget: () => { localStorage.removeItem(key); changed() },
  }
}

export const device = stored('nightcap.device')
export const profile = stored('nightcap.profile')

// The admin session the admin profile's PIN unlocks: kept for this
// tab only, so closing it locks admin again; it also ends on the server after 30 idle minutes.
export const adminSession = {
  get: () => { try { return sessionStorage.getItem('nightcap.admin') } catch { return null } },
  set: (token: string) => { try { sessionStorage.setItem('nightcap.admin', token) } catch { /* private mode */ } },
  forget: () => { try { sessionStorage.removeItem('nightcap.admin') } catch { /* private mode */ } },
}

/** An admin action that needs the PIN first: [pinUnset] when the admin profile has none yet. */
export class AdminLocked extends Said {
  pinUnset: boolean
  constructor(pinUnset: boolean) { super(pinUnset ? 'Set the admin PIN first' : 'Unlock admin with the PIN first'); this.pinUnset = pinUnset }
}

// Screens listen for this to notice the device key or profile changing (or being dropped).
const listeners = new Set<() => void>()
function changed() { listeners.forEach(l => l()) }
export function onIdentityChange(l: () => void) {
  listeners.add(l)
  return () => { listeners.delete(l) }
}

export class NotSignedIn extends Said {
  constructor() { super('This browser needs to join its household again.') }
}

/** Who's asking, for the server: this browser's key and the profile watching. */
function whoHeaders(init?: HeadersInit) {
  const headers = new Headers(init)
  const key = device.get(), p = profile.get()
  if (key) headers.set('X-Device-Key', key)
  if (p) headers.set('X-Profile', p)
  const admin = adminSession.get()
  if (admin) headers.set('X-Admin-Session', admin)
  return headers
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = whoHeaders(init?.headers)
  // Always check with the server: answers may be kept a minute (max-age), and right after a change
  // (marked watched, a setting) the page must show the new state, not the kept one.
  const res = await fetch(path, { cache: 'no-cache', ...init, headers }).catch(e => { throw offline(e) })
  if (res.headers.get('X-Join-Again')) {
    // This browser's key isn't known (any more): join the household again.
    forgetKept()
    profile.forget()
    device.forget()
    throw new NotSignedIn()
  }
  if (res.headers.get('X-Admin-Locked') || res.headers.get('X-Admin-Pin-Unset')) {
    // The admin session ended (or there's no PIN yet): the screen asks for the PIN and tries again.
    adminSession.forget()
    throw new AdminLocked(!!res.headers.get('X-Admin-Pin-Unset'))
  }
  if (res.headers.get('X-Profile-Unknown')) {
    // The server doesn't know this profile any more: ask who's watching again.
    const p = profile.get()
    if (p) forgetKept(p)
    profile.forget()
  }
  // An answer that isn't JSON (a page from a proxy, a server half-way through restarting) is an
  // error, not an empty answer: screens show it instead of breaking on missing fields.
  const { body, kind } = await read(res)
  if (!res.ok) throw new ApiError(body?.error ?? `Request failed (${res.status})`, res.status, kind, res.headers)
  if (body === undefined || body === null || typeof body !== 'object') throw new ApiError('The server answered something unexpected', res.status, kind, res.headers)
  return body as T
}

/** An answer's body, and what it was (the server's JSON, a web page, or nothing). */
async function read(res: Response): Promise<{ body: any; kind: Body }> {
  const type = res.headers.get('content-type') ?? ''
  const body = await res.json().catch(() => undefined)
  return { body, kind: body !== undefined ? 'json' : type.includes('text/html') ? 'html' : 'none' }
}

/** A failed answer as an ApiError (the server's text kept in it). */
async function failed(res: Response, fallback: string) {
  const { body, kind } = await read(res)
  return new ApiError(body?.error ?? `${fallback} (${res.status})`, res.status, kind, res.headers)
}

export const get = <T>(path: string) => call<T>(path)

export const post = <T>(path: string, body: unknown) =>
  call<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

export const homeFeed = () => get<Feed>('/launcher/home.json')
/** Brings this profile's Home up to date (recommendations too, when due) and answers it: up to a minute or two. */
export const refreshHome = () => post<Feed>('/launcher/refresh', {})
/** Home's two pages: Shows ("tv") and Movies ("movie"), each with its own rows, as Home is. */
export type PageKind = 'tv' | 'movie'
export const pageFeed = (kind: PageKind) => get<Feed>(`/launcher/page/${kind}.json`)
/** Brings the Shows or Movies page up to date and answers it (it asks the AI nothing). */
export const refreshPage = (kind: PageKind) => post<Feed>(`/launcher/page/${kind}/refresh`, {})

export const isTitle = (i: Item) => i.type === 'movie' || i.type === 'series'

// ---------- Joining a household ----------

export type Household = { id: string; name: string }

/** What joining this server takes: the households to pick from (at home), or a join code. */
export const households = () =>
  get<{ server: string; mode: 'home' | 'cloud'; codeRequired: boolean; households: Household[] }>('/join/households.json')

/** An id this browser keeps between joins (never forgotten with the key): joining again with it
 * replaces this browser's old entry on the Devices page instead of adding another. */
function installId() {
  let id = localStorage.getItem('nightcap.install')
  if (!id) {
    // getRandomValues, not randomUUID: the home server is plain http, where randomUUID is missing.
    id = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('')
    localStorage.setItem('nightcap.install', id)
  }
  return id
}

/** Joins a household (by picking it, or by its code) and keeps the key the server hands out. */
export async function join(how: { household: string } | { code: string }) {
  const r = await post<{ household: Household; key: string }>('/join',
    { ...how, device: deviceName(), kind: 'browser', install: installId() })
  // Joining another household: this browser leaves the one it was in (its old key stops working).
  // Only once the new one has let it in, so a wrong code doesn't leave it in neither.
  if (device.get()) await post<Ok>('/launcher/leave', {}).catch(() => {})
  forgetKept()
  device.set(r.key)
  return r.household
}

/** "Sign out of this browser": it leaves its household (the server removes it, so its key stops
 * working), and everything the app kept in this browser goes. */
export async function signOut() {
  await post<Ok>('/launcher/leave', {}).catch(() => {})
  for (const store of [localStorage, sessionStorage]) {
    try { Object.keys(store).filter(k => k.startsWith('nightcap.')).forEach(k => store.removeItem(k)) } catch { /* storage blocked */ }
  }
  changed()
}

/** What this browser is called on the household's Devices page ("Chrome on macOS"). */
function deviceName() {
  const ua = navigator.userAgent
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser'
  const os = /Mac OS/.test(ua) ? (/iPhone|iPad/.test(ua) ? 'iOS' : 'macOS') : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : ''
  return `${browser}${os ? ` on ${os}` : ''}`
}

/** The household's profiles, and which one is watching (none until one is chosen). */
export async function profiles(): Promise<{ profiles: Profile[]; me?: Profile }> {
  const r = await get<{ profiles: Profile[]; me: string | null }>('/launcher/profiles.json')
  const id = profile.get() ?? r.me
  return { profiles: r.profiles, me: r.profiles.find(p => p.id === id) }
}

// ---------- Title, person and Browse pages ----------

export const titlePage = (type: string, id: string) => get<Page>(`/launcher/title/${type}/${id}.json`)
export const personPage = (id: string) => get<Page>(`/launcher/person/${id}.json`)
export const browsePage = (key: string) => get<Page>(`/launcher/browse/${encodeURIComponent(key)}.json`)

/** Similar titles: the AI's picks once ready (ai: true), until then TMDB's own list. */
export const similar = (type: string, id: string) => get<{ ai: boolean; items: Card[] }>(`/launcher/similar/${type}/${id}.json`)
/** Works out the AI's picks for More like this now (a few seconds); TMDB's list again without the AI. */
export const rankSimilar = (type: string, id: string) => post<{ ai: boolean; items: Card[] }>(`/launcher/similar/${type}/${id}/rank`, {})

// ---------- Watch state ----------

type Ok = { ok: true }
/** An episode, a season ([season]), a whole show (the show's id) or a film, watched or not. */
export const markWatched = (type: string, id: string, watched: boolean, season?: number) =>
  post<Ok>('/launcher/watched', { type, id, watched, ...(season != null ? { season } : {}) })
export const setNotify = (id: string, on: boolean) => post<Ok>('/launcher/notify', { id, on })
export const rate = (id: string, value: -1 | 1 | 2 | null) => post<Ok>('/launcher/rating', { id, value })
/** Puts a title on this profile's My List ([on]) or takes it off (Home and the title's page are then stale). */
export const setMyList = (id: string, type: 'movie' | 'series', on: boolean) => post<Ok>('/launcher/mylist', { id, type, on })
export const notInterested = (id: string, type: string, name: string, row?: string) =>
  post<Ok>('/launcher/hide', { id, kind: 'notInterested', hidden: true, name, type, ...(row ? { row } : {}) })
export const opened = (id: string, origin: string, row?: string, slot?: number) =>
  post<Ok>('/launcher/interaction', { id, kind: 'opened', origin, row, slot }).catch(() => {})

// ---------- Playback ----------

/** Ranked sources and subtitles; [binge] keeps the same release through a season. Slow: add-ons take a while.
 * [audio]: always sent: the language picked in the player ("hi"), "*" for the one saved for this show, or
 * "" after the profile's own was picked (the server puts files in it first). */
export const play = (type: string, vid: string, o: { binge?: string | null; more?: boolean; audio?: string | null } = {}) => {
  const q = new URLSearchParams({ audio: o.audio ?? '*', ...(o.binge ? { binge: o.binge } : {}), ...(o.more ? { more: '1' } : {}) }).toString()
  return get<Play>(`/launcher/play/${type}/${vid}.json?${q}`).then(devLinks)
}

export { askLink, linkPath, type LinkAnswer } from './player/link'

/** New links for a play's same files (its token renewed, no new lookup): the new token and when it expires. */
export const renewLinks = (token: string, runtimeMs: number) =>
  post<{ token: string; linksExpireAt: number }>('/launcher/play/renew', { token, runtimeMs })

/** The audio languages each of these versions really has, read from its own track list (null: unread). */
export const audioLanguages = (links: string[]) =>
  post<{ languages: (string[] | null)[] }>('/launcher/audio-languages', { links: links.map(linkPath) })

/** A source that wouldn't play, so add-ons with many dead ones can be found (never "dead": a browser
 * can't tell a gone file from one it can't play). */
export const sourceFailed = (id: string, addon: string, error: string, filename?: string) =>
  post<Ok>('/launcher/source-failed', { id, addon, error, ...(filename ? { filename: filename.slice(0, 300) } : {}) }).catch(() => {})

/** A direct file whose host said it's gone (a 404 or 410 the page could read): seen gone, for the household. */
export const sourceGone = (id: string, addon: string, key: string) =>
  post<Ok>('/launcher/source-failed', { id, addon: addon || '?', key, dead: true }).catch(() => {})

/** A file the play answer marked seen gone (or dead) played after all: no longer held back. */
export const sourcePlayed = (id: string, key: string) => post<Ok>('/launcher/source-played', { id, key }).catch(() => {})

/** In development, playback links go through the dev server too (vite.config.ts), so they're on the
 * page's own address as they are in production: the smart player can only read them that way. */
function devLinks(p: Play): Play {
  if (!import.meta.env.DEV) return p
  const here = (u: string) => u.replace(/^https?:\/\/[^/]+(?=\/s\/)/, '')
  return { ...p, streams: p.streams.map(s => s.url ? { ...s, url: here(s.url) } : s), subtitles: p.subtitles.map(s => ({ ...s, url: here(s.url) })) }
}

export type Progress = {
  type: string; id: string; position: number; duration: number; played: number; origin?: string
  /** The audio language picked in the player for this show, once heard ("hi"; "" clears it). */
  audioPick?: string
  /** The subtitles picked in the player for this show ("eng", "pt-br", "off"). */
  subtitlePick?: string
}

/** Where playback is up to (and a pick for the show, if one is waiting). keepalive lets the last one go out
 * as the page closes. True once saved: a pick that couldn't be saved answers 503, and is sent again. */
export const saveProgress = (p: Progress, leaving = false) => {
  const sent = call('/launcher/progress', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p), keepalive: leaving,
  }).then(() => true, () => false)
  saving.add(sent)
  sent.then(() => saving.delete(sent))
  return sent
}
/** Progress saves on their way (the player just closed). */
const saving = new Set<Promise<boolean>>()
/** Resolves once every progress save on its way has had its answer: a page showing progress waits for
 * the player's last one, so it isn't shown from before it. */
export const progressSaved = () => Promise.all(Array.from(saving)).then(() => undefined)

// ---------- Settings ----------

export type Usage = {
  month: string; month_cost: number; month_calls: number; today_calls: number; today_cost: number
  /** Calls to a model without a price: their cost isn't in the totals (so a total is "at least"). */
  month_unpriced_calls?: number; today_unpriced_calls?: number
  /** Whether the household's model has a price now (the limit isn't applied while it hasn't). */
  priced?: boolean
  daily: { date: string; cost: number; calls: number; unpriced?: number }[]
  by_profile: { name: string; cost: number; calls: number; unpriced?: number }[]
  limit?: number | null; limitReached?: boolean
}

export type Location = { lat: number; lon: number; city: string; countryCode: string }

export type HouseholdSettings = {
  timezone?: string; country?: string; location?: Location | null
  aiLimit?: number | null
  home_defaults?: { languages?: string[]; top10_countries?: string[] }
}

export type ProfilePage = Profile & {
  still?: string | null
  weatherCity?: string | null
  usage?: Usage | null
  account?: HouseholdSettings | null
  settings: {
    languages: string[]; top10_countries: string[]; show_weather: boolean; showAi: boolean
    audio_language?: string; subtitles?: string; quality?: string
  }
  options: { languages: { code: string; name: string }[]; countries: { code: string; name: string }[] }
}

/** This profile's settings page: who it is, its settings, and (for the admin) the household. */
export async function profilePage(): Promise<ProfilePage> {
  const raw = await get<Record<string, any>>('/launcher/profile.json')
  return {
    ...raw,
    settings: { ...raw.settings, showAi: !!raw.settings?.show_ai },
    account: raw.account && { ...raw.account, aiLimit: raw.account.ai_monthly_limit_usd ?? null },
  } as ProfilePage
}

/** Changes a profile (yours, or any as the admin): name, avatar and/or some settings. */
export const changeProfile = (change: { id?: string; name?: string; avatar?: string; settings?: Record<string, unknown> }) =>
  post<Profile>('/launcher/profile', change)

export const saveSettings = (settings: Record<string, unknown>, id?: string) => changeProfile({ id, settings })

/** Whether the TV's Home shows the AI spend widget for this profile. */
export const saveShowAi = (on: boolean, id?: string) => saveSettings({ show_ai: on }, id)

export const addProfile = (name: string, avatar: string) => post<Profile>('/launcher/profiles', { name, avatar })
export const removeProfile = (id: string) => post<Ok>('/launcher/profiles/delete', { id })

/** The household's own settings (admin only). */
export const saveHousehold = (change: Record<string, unknown>) => post<unknown>('/launcher/account', change)
export const saveAiLimit = (usd: number | null) => saveHousehold({ ai_monthly_limit_usd: usd })

// ---------- The household: devices, join code, sources and keys ----------

/** A device's latest play, for the admin: what it's watching now, or watched last. */
export type Activity = {
  /** Playing now; [paused]: open on it, but not moving. */
  watching: boolean; paused?: boolean; id: string; type: 'movie' | 'series'; title: string; episode?: string; episodeName?: string
  picture?: string; poster?: string; position: number; duration: number; finished: boolean; at: string
  /** When it began, and when its position last moved. */
  started?: string; movedAt?: string | null
  profile: { id: string; name: string; avatar?: string | null }
}
export type Device = { id: string; name: string; kind: 'tv' | 'browser'; joined: string; lastUsed: string | null; thisDevice: boolean
  /** Only for the admin with the PIN unlocked; null when it hasn't played anything yet. */
  activity?: Activity | null }

// Devices without a kind of their own say "tv"; one named like "Chrome on macOS" is a browser.
export const deviceKind = (d: Device): 'tv' | 'browser' =>
  d.kind === 'browser' || /chrome|safari|firefox|edge|browser|\bweb\b/i.test(d.name) ? 'browser' : 'tv'

/** When a device joins again (after a server update, say), the server makes a new entry and the old
 * one stays, unused. Of entries of the same kind and name, the one used last is the device; the
 * others are left over. Returns the ids of those left over. */
export function leftovers(list: Device[]) {
  const latest = new Map<string, Device>()
  const when = (d: Device) => new Date(d.lastUsed ?? d.joined).getTime()
  for (const d of list) {
    const k = `${deviceKind(d)}|${d.name.toLowerCase()}`
    const seen = latest.get(k)
    if (!seen || when(d) > when(seen)) latest.set(k, d)
  }
  const keep = new Set([...latest.values()].map(d => d.id))
  return new Set(list.filter(d => !keep.has(d.id)).map(d => d.id))
}

/** Every TV and browser in the household (any device may list them). */
export const devices = () => get<{ devices: Device[] }>('/household/devices.json').then(r => r.devices)
/** The devices with what each is playing (the admin's Devices page); [activityUnavailable]: that couldn't be read. */
export const devicesActivity = () => get<{ devices: Device[]; activityUnavailable?: boolean }>('/household/devices.json')
/** Removes a device (admin profile): its key stops working at once. */
export const removeDevice = (id: string) => post<Ok>(`/household/devices/${id}/remove`, {})
/** A one-time sign-in code for a device that lost its key (admin profile): entered on it, it comes back
 * as itself, its name and history kept. Shown this once; a newer one cancels the older. */
export const deviceCode = (id: string) => post<NewInvite>(`/household/devices/${id}/code`, {})
/** Gives a device a name of its own (admin profile). */
export const renameDevice = (id: string, name: string) => post<Ok>(`/household/devices/${id}/rename`, { name })

/** An invite, as the owner and the admin see it (never its code): one device, once, within 24 hours.
 * [label] is who it's for, and the name of the device that joined with it. */
export type Invite = {
  id: string; label: string | null; madeBy: 'owner' | 'admin'; created: string; expiresAt: string
  state: 'open' | 'used' | 'expired'; usedAt: string | null; device: { id: string; name: string } | null
  /** A device's own sign-in code: the device it's for (it signs back in as itself). */
  for?: { id: string; name: string } | null
}
/** A just-made invite: its code is shown this once (the server keeps only a hash). */
export type NewInvite = { id: string; code: string; path: string; label: string | null; expiresAt: string; for?: { id: string; name: string } | null }
/** The ways to make, list and cancel a household's invites: the owner's, or its admin's. */
export type InviteMaker = {
  list: () => Promise<Invite[]>
  make: (label: string | null) => Promise<NewInvite>
  cancel: (id: string) => Promise<Ok>
  /** A used or expired one taken off the list, and all of them (the admin's; finished ones also go by
   * themselves after 7 days). */
  remove?: (id: string) => Promise<Ok>
  clear?: () => Promise<{ removed: number }>
}
/** The household's admin profile (unlocked with the PIN) makes invites for its own household. */
export const adminInvites: InviteMaker = {
  list: () => get<{ invites: Invite[] }>('/household/invites.json').then(r => r.invites),
  make: label => post<NewInvite>('/household/invites', { label }),
  cancel: id => post<Ok>(`/household/invites/${id}/cancel`, {}),
  remove: id => post<Ok>(`/household/invites/${id}/remove`, {}),
  clear: () => post<{ removed: number }>('/household/invites/clear', {}),
}


export type Addon = { id: string; address: string; /** Only asked when nothing else is verified (a plugin), and asleep most of the time. */ lastResort?: boolean }
export type Sources = {
  aiostreams: Addon | null
  streamAddons: Addon[]
  subtitleAddons: Addon[]
  /** The household's AI. [provider] and [providerName] are null for a key saved without its
   * provider (the key is needed again); [model] null: none chosen yet (no AI until then); [baseUrl] masked,
   * only for "other"; [price] [input, output] US$ per million tokens, null when it isn't known (the AI
   * still works; spending isn't counted). */
  ai: { provider: string | null; providerName: string | null; key: string; model: string | null; baseUrl: string | null; price: [number, number] | null } | null
  providers: AiProvider[]
  /** Nightcap's own AIOStreams (when the server runs one): the debrid services a key can be given
   * for, and whether the household's streams come through it (not while an address of its own is set). */
  nightcapAiostreams?: { available: boolean; inUse: boolean; services: { id: string; name: string; key: string | null }[] } | null
  failedLately: { addon: string; kind: 'lookup_failed' | 'lookup_timed_out' | 'wont_play'; times: number; last: string }[]
}
export type AddonKind = 'stream' | 'subtitle'
export type AiProvider = { id: string; name: string; needsBaseUrl: boolean; needsModel: boolean; defaultModel: string | null }
/** A model a key can use: [price] [input, output] US$ per million tokens, null when Nightcap doesn't know it. */
export type AiModel = { id: string; price: [number, number] | null; known: boolean }
/** What's saved for the household's AI: [key] null keeps the saved key (same provider; for "other", the
 * saved address); no [model] with [key] null removes the AI. */
export type AiSave = { provider: string; key: string | null; model?: string; baseUrl?: string | null; price?: [number, number] | null }

/** Where streams, subtitles and the AI come from (admin profile); addresses and keys come back masked. */
export const sources = () => get<Sources>('/household/sources.json')

// ---------- Live TV: watching (every profile) ----------

/** A channel (or a household's own item) as a card. An event's card lists its channels, each played by its id. */
export type LiveCard = {
  id: string; name: string; logo: string | null; mono: string; hue: number
  kind: string; kindName: string
  countries: { id: string; name: string }[]; languages: { id: string; name: string }[]
  favourite: boolean
  /** A household's own item: live, upcoming (shown, not played) or 24/7, its times (ms), and a line. */
  state?: 'live' | 'upcoming' | '24/7'; startsAt?: number; endsAt?: number; about?: string
  channels?: { id: string; name: string }[]
}
export type LiveRow = { key: string; title: string; kind?: string; row?: string; channels: LiveCard[]; count?: number }
export type LivePage = { lists: number; hero: LiveCard | null; rows: LiveRow[]; shown: number; total: number; hidden: number }
export type LiveBrowse = {
  channels: LiveCard[]; count: number; total: number; offset: number; hidden: number
  languagesSaid?: boolean
  filters: { kind?: string | null; countries?: string[]; languages?: string[]; q?: string }
  options: { kinds: LiveTvOption[]; countries: LiveTvOption[]; languages: LiveTvOption[] }
}
/** What a stream's handler needs to open it, as the list describes it (read only by the handler). */
export type LiveRecipe = Record<string, unknown>
export type LivePlay = { live: true; channel: LiveCard; streams: { url: string; name: string; hls: boolean; recipe?: LiveRecipe }[]; linksExpireAt?: number }

export const livePage = () => get<LivePage>('/livetv/page.json')
export const liveBrowse = (q: { kind?: string; row?: string; countries?: string; languages?: string; q?: string; offset?: number; limit?: number }) => {
  const params = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)]))
  return get<LiveBrowse>(`/livetv/browse.json?${params}`)
}
export const livePlay = (channel: string) => get<LivePlay>(`/livetv/play/${encodeURIComponent(channel)}.json`)
  // (In development, its links go through the dev server too, as a title's do: see devLinks.)
  .then(p => (import.meta.env.DEV ? { ...p, streams: p.streams.map(x => ({ ...x, url: x.url.replace(/^https?:\/\/[^/]+(?=\/s\/)/, '') })) } : p))
export const liveFavourite = (channel: string, on: boolean) => post<Ok>('/livetv/favourite', { channel, on })
export const liveWatching = (channel: string, seconds: number) => post<Ok>('/livetv/watching', { channel, seconds }).catch(() => {})
export const liveFailed = (channel: string) => post<Ok>('/livetv/failed', { channel }).catch(() => {})
/** Where a playback link leads (X-Where: 1), as the redirect would: a stream handler's [target]. */
export const linkTarget = async (link: string) => {
  const r = await fetch(link, { headers: { 'X-Where': '1' }, cache: 'no-store' }).catch(e => { throw offline(e) })
  if (!r.ok) throw await failed(r, 'The playback link answered')
  return ((await r.json()) as { url: string }).url
}

// ---------- Live TV: the household's channel lists (M3U), admin profile ----------

/** A list as Settings shows it: its address masked by the server (it may carry a paid account). */
export type LiveTvList = { id: string; name: string; address: string; channels: number; readAt: string | null; error?: string | null
  /** Advanced: how often it's read again (its setting, null: not set; and what's used now)… */
  refreshMinutes: number | null; everyMinutes: number
  /** …and which attribute plays each role now, the roles set away from their default, and the attributes
   * its items have (names only, most used first). */
  fields: Record<string, string>; fieldsSet: string[]; fieldsFound: { name: string; count: number }[] }
export type LiveTvOption = { id: string; name: string; count: number }
/** GET /household/livetv.json; every change answers with it again. */
export type LiveTvSettings = {
  lists: LiveTvList[]
  maxLists: number
  /** Where the page's channels come from: two-letter countries (INT: international), languages (none:
   * not said); empty means any. */
  places: { countries: string[]; languages: string[] }
  hidden: number
  /** Whether the lists say channels' languages enough for a language choice to mean something. */
  languagesSaid: boolean
  options: { kinds: LiveTvOption[]; countries: LiveTvOption[]; languages: LiveTvOption[] }
  /** What a list's attributes can mean (row, start…), with the attribute each reads by default. */
  roles: { id: string; name: string; default: string }[]
  refreshChoices: number[]
  defaultRefreshMinutes: number
}
export const liveTv = () => get<LiveTvSettings>('/household/livetv.json')
/** Adds a list: the server reads it at once (a few seconds); a 400 says why it couldn't. */
export const addLiveTvList = (url: string, name?: string) =>
  post<LiveTvSettings>('/household/livetv/lists', { url, ...(name ? { name } : {}) })
export const readLiveTvList = (id: string) => post<LiveTvSettings>(`/household/livetv/lists/${encodeURIComponent(id)}/read`, {})
export const removeLiveTvList = (id: string) => post<LiveTvSettings>(`/household/livetv/lists/${encodeURIComponent(id)}/remove`, {})
/** A list's Advanced settings: [refreshMinutes] one of refreshChoices (null: the default); [fields] the
 * roles read from another attribute than their default (a changed one reads the list again: 400 says why). */
export const setLiveTvListSettings = (id: string, refreshMinutes: number | null, fields: Record<string, string>) =>
  post<LiveTvSettings>(`/household/livetv/lists/${encodeURIComponent(id)}/settings`, { refreshMinutes, fields })
export const setLiveTvPlaces = (countries: string[], languages: string[]) =>
  post<LiveTvSettings>('/household/livetv/places', { countries, languages })
// Each change answers with the whole sources.json again.
export const setAiostreams = (url: string | null) => post<Sources>('/household/sources/aiostreams', { url })
export const addAddon = (kind: AddonKind, url: string) => post<Sources>(`/household/sources/addons/${kind}`, { url })
export const removeAddon = (kind: AddonKind, id: string) => post<Sources>(`/household/sources/addons/${kind}/${id}/remove`, {})
export const setAi = (body: AiSave) => post<Sources>('/household/sources/ai', body)
/** The chat models [key] can use (no key: the saved one, when it's that provider's). */
export const aiModels = (provider: string, key?: string | null, baseUrl?: string | null) =>
  post<{ models: AiModel[] }>('/household/sources/ai/models', { provider, ...(key ? { key } : {}), ...(baseUrl ? { baseUrl } : {}) }).then(r => r.models)
/** A debrid service's key for Nightcap's AIOStreams (null removes it); its setup there is updated at once. */
export const setDebridKey = (service: string, key: string | null) => post<Sources>(`/household/sources/debrid/${service}`, { key })

export type TestResult = { ok: boolean; name?: string; version?: string; error?: string; lastResort?: boolean }
/** Tests a saved source ({what, id?}), or one before it's saved ({what, url}; {what: 'ai', provider, key,
 * model, baseUrl}; or {what: 'ai', provider, model}: that model with the saved key). */
export const testSource = (what: Record<string, string | null | undefined>) => post<TestResult>('/household/sources/test', what)

/** Posters for a setting's preview: a language row's titles (lang:hi) or a country's Top 10 (top10:IN). */
export const settingPreview = (key: string) => get<{ posters: string[] }>(`/launcher/preview/${key}.json`)

// ---------- Search ----------

export type QuickResults = { titles: Card[]; people: Card[] }
/** As you type: titles and people from TMDB. */
export const quickSearch = (q: string) => get<QuickResults>(`/launcher/search/quick.json?q=${encodeURIComponent(q)}`)
/** Smart Search: the AI reads a description ("anime like Death Note"); [note] says when it can't. */
export const smartSearch = (q: string) => get<{ items: Card[]; note?: string }>(`/launcher/search/ai.json?q=${encodeURIComponent(q)}`)
/** This profile's recent searches (each profile has its own), and keeping one. */
/** What Search needs when it opens: recent searches, and whether this household has the AI (it's
 * optional: without a key, nothing about Smart Search shows). A server that doesn't say has it. */
export const searchStart = () => get<{ recent: string[]; aiAvailable?: boolean }>('/launcher/recent.json')
  .then(r => ({ recent: r.recent, ai: r.aiAvailable !== false }))
export const rememberSearch = (q: string) => post<{ recent: string[] }>('/launcher/recent', { q }).then(r => r.recent)
/** A title opened from Search (for the recommendations). */
export const searchedOpened = (id: string) =>
  post<Ok>('/launcher/interaction', { id, kind: 'searched_opened', origin: 'search' }).catch(() => {})

// ---------- Play on TV ----------

export type PlayWhat = { title: { type: 'movie' | 'series'; id: string } } | { link: { url: string; name?: string } }
export type PlayStatus = 'waiting' | 'shown' | 'accepted' | 'declined' | 'unreachable'

export class TvOff extends Said {}

/** A title to send: a series goes with an episode ([episode], else its first: S1 E1). */
export const titleToPlay = (type: 'movie' | 'series', id: string, episode?: string): PlayWhat =>
  ({ title: { type, id: type === 'series' ? episode ?? (id.includes(':') ? id : `${id}:1:1`) : id } })

/** Sends a title (an episode: "tt…:season:episode") or a link to one of the household's TVs, as this profile. */
export async function playOnTv(deviceId: string, what: PlayWhat) {
  try {
    return await post<{ request: number; status: PlayStatus }>(`/household/devices/${deviceId}/play`, what)
  } catch (e) {
    // The TV hasn't been used for a few minutes (off or asleep): said at once.
    if (e instanceof ApiError && e.headers.get('X-TV-Off')) throw new TvOff(e.message)
    throw e
  }
}
/** What became of a request: check every couple of seconds while it's waiting or shown. */
export const playStatus = (request: number) => get<{ status: PlayStatus }>(`/household/play/${request}.json`).then(r => r.status)

// ---------- Links played on the TV ----------

export type SentLink = {
  id: string; url: string; name: string
  position: number; duration: number  // ms
  sent_at: number; played_at: number | null  // seconds since 1970
  thumb: boolean
}

/** This profile's links (any video or .m3u8 address), most recently sent first. */
export const sentLinks = () => get<{ items: SentLink[] }>('/launcher/sent.json').then(r => r.items)
export const removeSent = (id: string) => post<Ok>(`/launcher/sent/${id}/delete`, {})

/** The picture the TV grabbed while playing a link, as an address for <img> (it needs who's asking). */
export async function sentThumb(id: string) {
  const res = await fetch(`/launcher/sent/${id}.jpg`, { headers: whoHeaders() }).catch(e => { throw offline(e) })
  if (!res.ok) throw await failed(res, 'No picture')
  return URL.createObjectURL(await res.blob())
}

// ---------- The server's owner (whoever deployed it) ----------
// The owner proves it with the owner key (X-Owner-Key), set when the server was deployed. No
// device key or profile: the owner looks after households, not inside one.

// The owner key, the server's master key: kept for this tab only (sessionStorage), so it's gone when
// the tab closes and asked for again next time. One in localStorage is cleared.
try { localStorage.removeItem('nightcap.owner') } catch { /* storage blocked */ }
export const ownerKey = {
  get: () => { try { return sessionStorage.getItem('nightcap.owner') } catch { return null } },
  set: (key: string) => { try { sessionStorage.setItem('nightcap.owner', key) } catch { /* storage blocked */ } },
  forget: () => { try { sessionStorage.removeItem('nightcap.owner') } catch { /* storage blocked */ } },
}

export class WrongOwnerKey extends Said {}

async function owner<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    cache: 'no-cache',
    headers: { 'X-Owner-Key': ownerKey.get() ?? '', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch(e => { throw offline(e) })
  if (res.status === 403) throw new WrongOwnerKey(await ownerRefusal(res))
  if (!res.ok) throw await failed(res, 'Request failed')
  return (await read(res)).body as T
}

/** Why the owner key was refused: the server's words (no key set on the server, one too short to be
 * used), else that it isn't the key. */
async function ownerRefusal(res: Response) {
  const { body } = await read(res)
  return typeof body?.error === 'string' && /^[A-Z]/.test(body.error) ? body.error : "That isn't the owner key."
}

export type OwnedHousehold = {
  id: string; name: string; created: string
  admin: { id: string; name: string } | null
  profiles: number; devices: number
  /** How many of its invites are open (made, not used yet, not expired). */
  openInvites: number
}

export const ownerHouseholds = () => owner<{ server: string; mode: 'home' | 'cloud'; households: OwnedHousehold[] }>('/server/households.json')
/** This server's version and the newest out (latest null: it couldn't be told), for its owner. */
export const ownerVersion = () => owner<{ version: string; latest: string | null; update: boolean }>('/server/version.json')
/** A new household with its admin profile, and its first invite, named for who it's for ([invite]). */
export const ownerCreate = (name: string, admin: string, invite: string, avatar?: string) =>
  owner<OwnedHousehold & { invite: NewInvite }>('/server/households', { name, admin, invite, avatar })
export const ownerRename = (id: string, name: string) => owner<Ok>(`/server/households/${id}/rename`, { name })
/** Deletes a household and everything in it ([confirm] is its name); its devices stop at once. */
export const ownerDelete = (id: string, confirm: string) => owner<Ok>(`/server/households/${id}/delete`, { confirm })
export const ownerProfiles = (id: string) => owner<{ profiles: Profile[] }>(`/server/households/${id}/profiles.json`).then(r => r.profiles)
export const ownerSetAdmin = (id: string, profileId: string) => owner<Ok>(`/server/households/${id}/admin`, { profile: profileId })
/** The owner's way to make, list and cancel one household's invites. */
export const ownerInvites = (household: string): InviteMaker => ({
  list: () => owner<{ invites: Invite[] }>(`/server/households/${household}/invites.json`).then(r => r.invites),
  make: label => owner<NewInvite>(`/server/households/${household}/invite`, { label }),
  cancel: id => owner<Ok>(`/server/households/${household}/invites/${id}/cancel`, {}),
})

/** The web app's page for an invite: the code after #, which browsers never send to the server (so
 * it can't end up in a log). */
export const inviteLink = (code: string) => `${location.origin}${import.meta.env.BASE_URL}join#${code}`

// ---------- Moving households to another server (the owner) ----------

/** Every household ([ids] null) or some, as one file locked with [password]: answers the file and its name. */
export async function ownerExport(ids: string[] | null, password: string) {
  const res = await fetch('/server/export', {
    method: 'POST', cache: 'no-store',
    headers: { 'X-Owner-Key': ownerKey.get() ?? '', 'Content-Type': 'application/json' },
    body: JSON.stringify({ households: ids, password }),
  }).catch(e => { throw offline(e) })
  if (!res.ok) {
    if (res.status === 403) throw new WrongOwnerKey(await ownerRefusal(res))
    throw await failed(res, 'Export failed')
  }
  const name = res.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/)?.[1] ?? 'nightcap.nightcap'
  return { blob: await res.blob(), name }
}

/** A household in an import file: new here, or already here (under [nameHere], which can differ). */
export type InFile = { id: string; name: string; here: boolean; nameHere: string | null; profiles: number; devices: number }
export type Imported = InFile & { status: 'created' | 'replaced' | 'skipped' }

/** The households in an exported file. First with [check] (nothing changes: which are new, which are
 * here already); then the import: new ones are created, ones here replaced if their id is in
 * [replace], else skipped. Wrong password: an error saying so. */
// The server takes import bodies up to [maxImportBytes] (its limits; 100 MB by default); base64 makes
// the file a third bigger, so the file itself can be about three quarters of that.
export const importMaxFileBytes = (maxImportBytes = limits().maxImportBytes) => Math.floor((maxImportBytes * 3) / 4) - 4096

export async function ownerImport(file: File, password: string, how: { check: true } | { replace: string[] }) {
  const most = importMaxFileBytes()
  if (file.size > most) {
    throw new Said(`That file is ${Math.round(file.size / 1048576)} MB; the server takes files up to about ${Math.floor(most / 1048576)} MB.`)
  }
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  try {
    const answer = await owner<{ households?: InFile[]; imported?: Imported[] }>('/server/import', { file: btoa(binary), password, ...how })
    return (answer.imported ?? answer.households ?? []) as Imported[]
  } catch (e) {
    // The server answers 403 for a wrong password too (the owner key was right to get this far).
    if (e instanceof WrongOwnerKey) throw new Said("Wrong password, or that isn't an exported file.")
    if (e instanceof ApiError && e.status === 413) throw new Said('The server says the file is too big to take in one go.')
    throw e
  }
}

// ---------- The admin PIN ----------

/** Whether the admin profile has a PIN, and whether this tab is unlocked now. */
export const adminStatus = () => get<{ pinSet: boolean; unlocked: boolean }>('/household/admin.json')

export class WrongPin extends Said {
  triesLeft: number
  constructor(triesLeft: number) { super("That isn't the admin PIN."); this.triesLeft = triesLeft }
}
export class PinLocked extends Said {
  seconds: number
  constructor(seconds: number) { super('Too many wrong PINs.'); this.seconds = seconds }
}

/** Unlocks admin on this device with the PIN (kept for this tab). */
export async function adminUnlock(pin: string) {
  const res = await fetch('/household/admin/unlock', {
    method: 'POST', cache: 'no-store',
    headers: whoHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ pin }),
  }).catch(e => { throw offline(e) })
  const { body = {}, kind } = await read(res)
  if (res.status === 429) throw new PinLocked(body.lockedFor ?? 900)
  if (res.headers.get('X-Admin-Pin-Unset')) throw new AdminLocked(true)
  if (!res.ok) {
    if (typeof body.triesLeft === 'number') throw new WrongPin(body.triesLeft)
    throw new ApiError(body.error ?? `Couldn't unlock (${res.status})`, res.status, kind, res.headers)
  }
  adminSession.set(body.session)
}

/** Sets the admin PIN (the first one freely; a new one while unlocked), and unlocks this tab. */
export async function adminSetPin(pin: string) {
  const r = await post<{ session: string }>('/household/admin/pin', { pin })
  adminSession.set(r.session)
}

/** Locks admin again on this device. */
export async function adminLock() {
  await post<Ok>('/household/admin/lock', {}).catch(() => {})
  adminSession.forget()
}

/** The owner clears a household admin profile's forgotten PIN. */
export const ownerResetPin = (id: string) => owner<Ok>(`/server/households/${id}/admin-pin/reset`, {})
