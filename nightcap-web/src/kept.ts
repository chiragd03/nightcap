// What the app keeps in this browser to show at once next time, before the server has answered (it
// may be asleep): the last Home of each profile (screens/Home.tsx) and the household's profiles
// (session.tsx). Gone when this browser leaves or rejoins a household, and a profile's when the
// server no longer knows it. (Signing out clears everything the app kept.)

const HOME = 'nightcap.home.'
export const PROFILES = 'nightcap.profiles'

export const homeKey = (profile: string, page: string) => `${HOME}${profile}.${page}`

export function readKept<T>(key: string): T | undefined {
  try {
    const s = localStorage.getItem(key)
    return s ? (JSON.parse(s) as T) : undefined
  } catch { return undefined }
}

/** Kept unless it's bigger than [max] characters (or storage is full or blocked). */
export function keep(key: string, value: unknown, max = 150_000) {
  try {
    const s = JSON.stringify(value)
    if (s.length <= max) localStorage.setItem(key, s)
    else localStorage.removeItem(key)
  } catch { /* storage full or blocked */ }
}

/** Everything kept (another household, or this browser's key gone), or one profile's Home. */
export function forgetKept(profile?: string) {
  try {
    const prefix = profile ? `${HOME}${profile}.` : HOME
    Object.keys(localStorage).filter(k => k.startsWith(prefix)).forEach(k => localStorage.removeItem(k))
    if (!profile) localStorage.removeItem(PROFILES)
  } catch { /* storage blocked */ }
}
