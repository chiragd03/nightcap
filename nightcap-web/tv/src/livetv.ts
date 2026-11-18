// Live TV's calls, as the web app's: the page, Browse all, a channel's
// streams, My channels, and saying what played (watching) or didn't (failed: hidden on this TV after
// a few). The cards are the web app's types.

import type { LiveBrowse, LiveCard, LivePage, LivePlay } from '../../src/api'
import * as api from './api'
import * as store from './store'

export type { LiveBrowse, LiveCard, LivePage, LivePlay }

export const page = () => api.call<LivePage>('/livetv/page.json')

export function browse(q: { kind?: string; row?: string; q?: string; offset?: number; limit?: number }) {
  const params = Object.entries(q).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&')
  return api.call<LiveBrowse>(`/livetv/browse.json?${params}`)
}

export const play = (channel: string) => api.call<LivePlay>(`/livetv/play/${encodeURIComponent(channel)}.json`, { timeout: api.TIMEOUT.slow })
  // (In development its links go through the dev server too, as the web app's: the server names its
  // own address, which isn't this page's. On a TV the server serves the app, so they're the same.)
  .then(p => (import.meta.env.DEV ? { ...p, streams: p.streams.map(x => ({ ...x, url: x.url.replace(/^https?:\/\/[^/]+(?=\/s\/)/, '') })) } : p))

export const favourite = (channel: string, on: boolean) => api.post('/livetv/favourite', { channel, on })
export const watching = (channel: string, seconds: number) => api.send('/livetv/watching', { channel, seconds })
export const failed = (channel: string) => api.send('/livetv/failed', { channel })

/** Where a playback link leads (for a stream with a recipe): asked with X-Where, as JSON, since a
 * redirect's address can't be read. */
export async function linkTarget(link: string): Promise<string> {
  const headers: Record<string, string> = { 'X-Where': '1' }
  const key = store.deviceKey.get(), profile = store.currentProfile.get()
  if (key) headers['X-Device-Key'] = key
  if (profile) headers['X-Profile'] = profile
  const r = await fetch(link, { headers, cache: 'no-cache' })
  const body = await r.json() as { url?: string }
  if (!r.ok || !body.url) throw new Error("Couldn't open that stream")
  return body.url
}

/** As the Android TV's: "7:30 PM" today, "Tue · 7:30 PM" within the coming week, else
 * "Tue 1 Jun · 7:30 PM" (with the year when it isn't this one). */
export function timeText(ms: number) {
  const d = new Date(ms), now = new Date()
  const h = d.getHours() % 12 || 12
  const time = `${h}:${String(d.getMinutes()).padStart(2, '0')} ${d.getHours() < 12 ? 'AM' : 'PM'}`
  const sameYear = d.getFullYear() === now.getFullYear()
  if (sameYear && d.toDateString() === now.toDateString()) return time
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const withinWeek = ms - Date.now() >= 0 && ms - Date.now() < 6 * 24 * 3600 * 1000
  const day = withinWeek ? DAYS[d.getDay()] : `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}${sameYear ? '' : ` ${d.getFullYear()}`}`
  return `${day} · ${time}`
}

/** The channels hidden on this TV because they didn't play (Browse all's "Didn't play"). */
export const hidden = () => api.call<{ channels: LiveCard[] }>('/livetv/hidden.json')

/** A tint of its own for a kind (the same each time), as the web app's tiles. */
export function hueOf(id: string) {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360
  return h
}
