// Home's data: the server's Home, kept per
// profile on this TV so Home opens at once with the last one, then refreshed.

import * as api from './api'
import * as prefs from './player/prefs'
import * as profiles from './profiles'

export type Item = {
  id: string
  type: string            // movie, series, tile
  name: string
  year?: string
  rating?: number
  poster?: string
  backdrop?: string
  trailer?: string
  overview?: string
  reason?: string
  episode?: string        // "S2 E5"
  progress?: number       // 0-1
  videoId?: string        // the episode, tt…:s:e
  newEpisodes?: number
  rank?: number
  label?: string          // the featured carousel's: "2 new episodes", "Picked for you", "New"
  muted?: boolean
  lastWatched?: string
  nextVideoId?: string
  nextEpisode?: string
}

export type Row = { id: string; title: string; style?: string; items: Item[]; requestId?: string; modelVersion?: string }

/** [building]: a profile's first Home, still being set up on the server (only Continue watching; the
 * full one comes by the refresh). */
export type Home = { rows: Row[]; stale: boolean; building: boolean }

const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : v != null && typeof v === 'number' ? String(v) : undefined)
const num = (v: unknown) => (typeof v === 'number' && isFinite(v) ? v : undefined)

function item(raw: Record<string, unknown>): Item | null {
  const id = str(raw.id)
  if (!id) return null
  return {
    id,
    type: str(raw.type) ?? 'movie',
    name: typeof raw.name === 'string' ? raw.name : id,
    year: str(raw.year), rating: num(raw.rating), poster: str(raw.poster), backdrop: str(raw.backdrop),
    trailer: str(raw.trailer), overview: str(raw.overview), reason: str(raw.reason), episode: str(raw.episode),
    progress: num(raw.progress), videoId: str(raw.videoId), newEpisodes: num(raw.newEpisodes), rank: num(raw.rank),
    label: str(raw.label), muted: raw.muted === true, lastWatched: str(raw.lastWatched),
    nextVideoId: str(raw.nextVideoId), nextEpisode: str(raw.nextEpisode),
  }
}

const items = (list: unknown) => (Array.isArray(list) ? list.map(x => (x && typeof x === 'object' ? item(x as Record<string, unknown>) : null)).filter((x): x is Item => !!x) : [])

/** The server's Home as rows, the featured titles first (as the row "featured"). Unlike the Android
 * TV, one odd field (a null number) doesn't throw the whole Home away: that title or row is skipped. */
export function parse(json: string): Home | null {
  let root: Record<string, unknown>
  try { root = JSON.parse(json) } catch { return null }
  if (!root || typeof root !== 'object' || !Array.isArray(root.rows)) return null
  const rows: Row[] = []
  const featured = items(root.featured)
  if (featured.length) rows.push({ id: 'featured', title: '', style: 'featured', items: featured })
  for (const r of root.rows as Record<string, unknown>[]) {
    const id = r && str(r.id)
    if (!id) continue
    const list = items(r.items)
    if (!list.length) continue
    rows.push({ id, title: typeof r.title === 'string' ? r.title : '', style: str(r.style), items: list,
      requestId: str(r.requestId), modelVersion: str(r.modelVersion) })
  }
  return { rows, stale: root.stale === true, building: root.building === true }
}

// ---------- Kept per profile ----------

/** Home's pages: Shows ("tv") and Movies ("movie"), each with its own rows; null for Home itself. */
export type Page = 'tv' | 'movie' | null

const key = (page: Page) => `nightcap.tv.home.${profiles.currentId() ?? 'default'}${page ? `-${page}` : ''}`

export function cached(page: Page = null): string | null {
  try { return localStorage.getItem(key(page)) } catch { return null }
}

/** Kept under [where]: the key worked out as it was asked for (a profile switched to meanwhile never
 * gets another's Home). */
function keep(json: string, where: string) {
  try { localStorage.setItem(where, json) } catch { /* storage full: next time from the server */ }
}

// ---------- From the server ----------

async function text(path: string, opts: { body?: unknown; timeout?: number } = {}) {
  const r = await api.request(path, opts)
  if (!r.ok) throw new api.ServerError('Home failed', r.status)
  const json = JSON.stringify(r.body)
  // Only a Home that reads is kept (a hotel Wi-Fi page answers 200 too): else it's a failure.
  if (!parse(json)) throw new api.ServerError('Home failed', r.status)
  return json
}

/** The server's Home (or its Shows or Movies [page]) now, kept for this profile. The profile list is
 * refreshed alongside. */
export async function download(page: Page = null): Promise<string> {
  profiles.fetchList()
  // The player's languages in step with the server's.
  prefs.sync()
  // (The profile it's asked for, and its key, before the request.)
  const where = key(page)
  const json = await text(page ? `/launcher/page/${page}.json` : '/launcher/home.json')
  keep(json, where)
  return json
}

/** A Home (or [page]) the server said is stale, built again (Home's 1-2 minutes at most; a page's asks
 * the AI nothing). */
export async function refresh(page: Page = null): Promise<string> {
  const where = key(page)
  const json = await text(page ? `/launcher/page/${page}/refresh` : '/launcher/refresh', { body: {}, timeout: api.TIMEOUT.refresh })
  keep(json, where)
  return json
}

/** The weather and the AI spend: null when nothing usable came back (left as they
 * were); an answer without them (an error, or turned off) hides them. */
export type Widgets = {
  weather?: { city?: string; temp?: number; feels?: number; condition?: string; icon?: string; high?: number; low?: number }
  ai?: { month?: string; month_cost?: number; month_unpriced_calls?: number }
}
export async function widgets(): Promise<Widgets | null> {
  try {
    const r = await api.request('/launcher/widgets.json')
    return r.body as Widgets
  } catch { return null }
}
