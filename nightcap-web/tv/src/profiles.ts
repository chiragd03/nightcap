// Who's watching, as the Android app's:
// the household's profiles as last fetched (kept on this TV), the one chosen, and whether
// to ask again (after the TV slept). The avatars are the web app's (same keys, tints and pictures).

import { AVATARS, avatarOf } from '../../src/avatars'
import * as api from './api'
import * as store from './store'

export type Profile = { id: string; name: string; avatar: string | null; isAdmin: boolean }

export { AVATARS }
export const avatar = (p: Pick<Profile, 'id' | 'avatar'>) => avatarOf(p.avatar, p.id)
/** The avatar pictures are the web app's, served at /app/avatars/. */
export const avatarSrc = (image: string) => `/app/avatars/${image}.png`

/** The list as last fetched (possibly stale; nothing if it can't be read). */
export function list(): Profile[] {
  try {
    const got = JSON.parse(store.profileList.get() ?? '{}') as { profiles?: Profile[] }
    return Array.isArray(got.profiles) ? got.profiles.filter(p => p && typeof p.id === 'string') : []
  } catch { return [] }
}

export const currentId = () => store.currentProfile.get()

/** The profile chosen, else the first in the list. */
export function current(): Profile | undefined {
  const all = list(), id = currentId()
  return all.find(p => p.id === id) ?? all[0]
}

/** Whether the profile chosen is the admin: only the admin adds and removes profiles. (None chosen
 * yet isn't the admin.) */
export function isAdmin() {
  const id = currentId()
  return list().some(p => p.id === id && p.isAdmin)
}

/** Downloads the list and keeps it: the list now, or null if the server couldn't be reached (the kept
 * one stands). */
export async function download(): Promise<Profile[] | null> {
  try {
    const got = await api.call<{ profiles: Profile[] }>('/launcher/profiles.json')
    store.profileList.set(JSON.stringify(got))
  } catch { return null }
  return list()
}

/** Downloads the list and keeps it; the list as now known (the kept one if the download failed). */
export async function fetchList(): Promise<Profile[]> {
  await download()
  return list()
}

/** Watching as [p]: another profile starts with admin locked, and everything is shown afresh. */
export function choose(p: Profile) {
  if (currentId() === p.id) return
  store.currentProfile.set(p.id)
  api.setAdminSession(null)
  api.markChanged()
  onChosen.forEach(f => f())
}
const onChosen = new Set<() => void>()
/** Something to drop when the profile changes (the page cache). */
export const whenChosen = (f: () => void) => { onChosen.add(f) }

/** Whether to ask who's watching now: with none chosen, one profile is chosen without
 * asking (else ask); with one chosen, ask only after the TV slept and when there's a choice. */
export function shouldAsk() {
  const all = list()
  if (!currentId()) {
    if (all.length === 1) { choose(all[0]); return false }
    return true
  }
  if (store.askNext.get() && all.length > 1) return true
  store.askNext.set(null)
  return false
}

export const askNextTime = () => store.askNext.set('1')
export const asked = () => store.askNext.set(null)
