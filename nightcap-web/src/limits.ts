// What the server allows (GET /limits.json, set by whoever runs it), so
// the apps allow the same: how many profiles and devices, name lengths, the PIN's length, the audio
// languages… The server is the only source of them: the apps keep no copy. Asked as an app starts and
// again until it answers (a server asleep, or not reachable yet); the screens that need them
// (WithLimits) wait for it, saying so. Both apps (web and TV) read them from here.

import { useSyncExternalStore } from 'react'

export type Limits = {
  maxProfiles: number
  maxDevices: number
  maxAddons: number
  maxOpenInvites: number
  inviteCodeLength: number
  inviteHours: number
  names: { profile: number; household: number; device: number; inviteLabel: number }
  pin: { min: number; max: number }
  exportPasswordMin: number
  maxImportBytes: number
  monthlyLimitMaxUsd: number
  audioLanguages: { code: string; name: string; native: string }[]
}

let current: Limits | null = null
let failures = 0
let asking = false
let retry: ReturnType<typeof setTimeout> | undefined
const listeners = new Set<() => void>()
const waiting: ((l: Limits) => void)[] = []

const tell = () => listeners.forEach(l => l())

/** Asks the server, and again (sooner after a failure, then less often) until it answers. */
export function loadLimits(): void {
  if (current || asking) return
  asking = true
  clearTimeout(retry)
  fetch('/limits.json', { cache: 'no-cache' })
    .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((got: Limits) => {
      current = got
      waiting.splice(0).forEach(w => w(got))
      tell()
    })
    .catch(() => {
      failures++
      tell()
      // (2, 4, 8… seconds, at most 30: a server waking takes a few.)
      retry = setTimeout(loadLimits, Math.min(30_000, 2_000 * 2 ** Math.min(failures - 1, 4)))
    })
    .finally(() => { asking = false })
}

// The network back, or the app in front again: asked at once if it's still missing.
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => { if (!current) { clearTimeout(retry); loadLimits() } })
  document.addEventListener('visibilitychange', () => { if (!current && !document.hidden) { clearTimeout(retry); loadLimits() } })
}

/** The limits, once the server has said them (only under WithLimits, or after whenLimits). */
export function limits(): Limits {
  if (!current) throw new Error("The server's limits aren't in yet")
  return current
}

/** The limits once they're in. */
export const whenLimits = (): Promise<Limits> => (current ? Promise.resolve(current) : new Promise(r => waiting.push(r)))

/** The limits for a screen, or null while they're on their way (it shows again when they come). */
export function useLimits(): Limits | null {
  return useSyncExternalStore(l => { listeners.add(l); return () => { listeners.delete(l) } }, () => current)
}

/** Whether asking has failed so far (for saying "can't reach the server" rather than "loading"). */
export function useLimitsFailing(): boolean {
  return useSyncExternalStore(l => { listeners.add(l); return () => { listeners.delete(l) } }, () => !current && failures > 0)
}

/** The limits, in a screen under WithLimits (or a TV screen that waited for them): always in by then. */
export function useLimitsReady(): Limits {
  const l = useLimits()
  if (!l) throw new Error("The server's limits aren't in yet: wrap the screen in WithLimits")
  return l
}
