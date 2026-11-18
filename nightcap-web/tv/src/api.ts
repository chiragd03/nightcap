// Every call to the Nightcap server, as the Android TV app's:
// the server is the one serving this app, so calls are same-origin; each carries this TV's
// key, who's watching and an unlocked admin session. No retries: one try, and the error is shown.

import { deviceName, installId } from './platform'
import * as store from './store'

/** How long a call may take (the Android app's read timeouts). */
export const TIMEOUT = { normal: 20_000, slow: 60_000, refresh: 150_000 }

/** The admin PIN's session: in memory only, so a restart forgets it (and another profile clears it). */
export let adminSession: string | null = null
export const setAdminSession = (s: string | null) => { adminSession = s }

/** This TV was forgotten by the server (removed on the Devices page, or the household deleted):
 * the app goes to Connect with nothing to go back to. */
type Forgotten = (household: string) => void
let onForgotten: Forgotten = () => {}
export const whenForgotten = (f: Forgotten) => { onForgotten = f }

export class ServerError extends Error {
  status: number
  /** The fetch's own TypeError when the server couldn't be reached at all (no connection), kept as an own
   * field: Error's `cause` needs Chrome 93. Never set for a timeout. */
  offline?: TypeError
  constructor(message: string, status: number, offline?: TypeError) {
    super(message)
    this.status = status
    if (offline) this.offline = offline
  }
}

/** What a failure says, by where it happened: Connect's own words, or the rest of the app's. */
export type Words = { unreachable: string; notNightcap: string }
const APP_WORDS: Words = { unreachable: "Couldn't reach the server. Try again.", notNightcap: "Couldn't reach the server. Try again." }
export const CONNECT_WORDS: Words = {
  unreachable: "Couldn't reach a Nightcap server there.",
  notNightcap: "That address answered, but it isn't a Nightcap server.",
}

/** [keepalive]: sent even as the page goes away (leaving the player, the TV put away). */
type Opts = { method?: 'GET' | 'POST'; body?: unknown; timeout?: number; words?: Words; keepalive?: boolean }

/** A call's whole answer, whatever its status (a screen that needs an error's details: the admin
 * PIN's tries left). Throws only when nothing usable came back. */
export async function request(path: string, opts: Opts = {}): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const words = opts.words ?? APP_WORDS
  const headers: Record<string, string> = {}
  const key = store.deviceKey.get(), profile = store.currentProfile.get()
  if (key) headers['X-Device-Key'] = key
  if (profile) headers['X-Profile'] = profile
  if (adminSession) headers['X-Admin-Session'] = adminSession
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'

  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), opts.timeout ?? TIMEOUT.normal)
  let res: Response
  try {
    res = await fetch(path, {
      method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
      headers, cache: 'no-cache', signal: abort.signal, keepalive: !!opts.keepalive,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    })
  } catch (e) {
    // (Aborted: the timeout. A TypeError otherwise: no connection.)
    throw new ServerError(words.unreachable, 0, !abort.signal.aborted && e instanceof TypeError ? e : undefined)
  } finally {
    clearTimeout(timer)
  }

  if (res.headers.get('X-Join-Again')) forget()
  if (res.headers.get('X-Profile-Unknown')) {
    // The profile was removed elsewhere: ask who's watching next time.
    store.currentProfile.set(null)
    store.askNext.set('1')
  }
  let body: unknown
  try { body = await res.json() } catch { throw new ServerError(words.notNightcap, res.status) }
  if (!body || typeof body !== 'object') throw new ServerError(words.notNightcap, res.status)
  return { ok: res.ok, status: res.status, body: body as Record<string, unknown> }
}

/** A call's answer, or a ServerError with the server's words (or the screen's) when it failed. */
export async function call<T>(path: string, opts: Opts = {}): Promise<T> {
  const { ok, status, body } = await request(path, opts)
  if (!ok) {
    const said = body.error
    throw new ServerError(typeof said === 'string' && said ? said : `The server said no (${status}).`, status)
  }
  return body as T
}

/** A change the user made (watched, a setting): marks everything that shows it as out of date. */
export async function post<T>(path: string, body: unknown, timeout?: number): Promise<T> {
  const answer = await call<T>(path, { body, timeout })
  markChanged()
  return answer
}

/** A call nobody waits for (a title opened): failures don't matter. */
export const send = (path: string, body: unknown) => { call(path, { body }).catch(() => {}) }

/** When something the screens show last changed: Home and title pages refetch on return
 * if it's newer than what they show. */
export let changedAt = 0
export const markChanged = () => {
  changedAt = Date.now()
  // (A screen in front that shows what changed catches up now, not on its next visit; after the call
  // that made the change has had its answer, so its own screen counts it as seen first.)
  changeListeners.forEach(fn => setTimeout(() => { if (changeListeners.indexOf(fn) >= 0) fn() }, 0))
}
const changeListeners: (() => void)[] = []
/** Calls [fn] after each change (markChanged) until the returned function is called (as the Android TV's,
 * set by a screen while it's in front). */
export function whenChanged(fn: () => void) {
  changeListeners.push(fn)
  return () => { const i = changeListeners.indexOf(fn); if (i >= 0) changeListeners.splice(i, 1) }
}

/** The server no longer knows this TV's key: only the key goes (the household is kept, so joining
 * the same one again keeps who's watching). */
export function forget() {
  if (!store.deviceKey.get()) return
  const was = store.household.get()?.trim()
  store.deviceKey.set(null)
  onForgotten(was || 'your household')
}

// ---------- Joining (Connect) ----------

export type Households = { server: string; codeRequired: boolean; households: { id: string; name: string }[] }

export async function households(): Promise<Households> {
  const r = await call<Partial<Households>>('/join/households.json', { words: CONNECT_WORDS })
  const list = Array.isArray(r.households) ? r.households.filter(h => h && typeof h.id === 'string' && typeof h.name === 'string') : []
  return { server: r.server || 'Nightcap', codeRequired: r.codeRequired ?? true, households: list }
}

/** Joins with a household's id (a home server that lists them) or an invite's code, and keeps the key. */
export async function join(how: { household: string } | { code: string }) {
  const r = await call<{ household?: { id?: string; name?: string }; key?: string }>('/join', {
    body: { ...how, device: deviceName(), install: installId(), kind: 'tv' }, words: CONNECT_WORDS,
  })
  if (!r.key || !r.household?.id) throw new ServerError("That address answered, but it isn't a Nightcap server.", 200)
  // Another household's profiles aren't this one's; the same household joined again keeps them.
  if (store.householdId.get() !== r.household.id) store.forgetProfiles()
  store.household.set(r.household.name ?? '')
  store.householdId.set(r.household.id)
  store.deviceKey.set(r.key)
}

/** This TV leaves its household: it stops using it, and needs a new invite to come back. */
export async function leave() {
  try {
    await call('/launcher/leave', { body: {} })
  } catch (e) {
    // 401: the server had already forgotten this TV, which is leaving all the same.
    if (!(e instanceof ServerError) || e.status !== 401) {
      throw new ServerError(e instanceof ServerError && e.status === 0 ? "Couldn't reach the server. Try again." : "Couldn't leave. Try again.", 0)
    }
  }
  forgetHere()
}

/** The household in use, forgotten on this TV only (its server couldn't be reached to leave it): that
 * server keeps the TV on its list until it's removed there. */
export function forgetHere() {
  store.deviceKey.set(null)
  store.householdId.set(null)
  store.forgetProfiles()
}
