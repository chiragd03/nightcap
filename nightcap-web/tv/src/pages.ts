// Title, person and Browse pages, Search's answers, and "More like this":
// the last 20 answers are kept in memory by address, and
// used again unless asked fresh. Dropped when the profile changes.

import type { Card, Header, Page, Section } from '../../src/types'
import * as api from './api'
import * as profiles from './profiles'

export type { Card, Header, Page, Section }

const KEEP = 20
const kept = new Map<string, unknown>()
profiles.whenChosen(() => kept.clear())
export const clear = () => kept.clear()

export async function get<T>(path: string, fresh = false, timeout?: number): Promise<T> {
  if (!fresh && kept.has(path)) {
    const v = kept.get(path) as T
    kept.delete(path)
    kept.set(path, v)
    return v
  }
  const v = await api.call<T>(path, { timeout })
  remember(path, v)
  return v
}

export function remember(path: string, v: unknown) {
  kept.delete(path)
  kept.set(path, v)
  while (kept.size > KEEP) kept.delete(kept.keys().next().value as string)
}

/** Forgets a page kept here (it's asked fresh next time). */
export const forget = (path: string) => { kept.delete(path) }

/** Forgets every kept More like this list (a title said Not interested to is in none of them now). */
export function forgetSimilar() {
  Array.from(kept.keys()).filter(k => k.indexOf(SIMILAR_PREFIX) === 0).forEach(k => kept.delete(k))
}

export type Kind = 'movie' | 'series' | 'person' | 'browse'

export const pagePath = (kind: Kind, id: string) =>
  kind === 'person' ? `/launcher/person/${encodeURIComponent(id)}.json`
    : kind === 'browse' ? `/launcher/browse/${encodeURIComponent(id)}.json`
    : `/launcher/title/${kind}/${encodeURIComponent(id)}.json`

const SIMILAR_PREFIX = '/launcher/similar/'
export const similarPath = (kind: 'movie' | 'series', id: string) => `${SIMILAR_PREFIX}${kind}/${encodeURIComponent(id)}.json`

/** "2026-12-25" as "25 Dec 2026" (anything else as it is). */
export function niceDate(s?: string, withYear = true) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s ?? '')
  if (!m) return s ?? ''
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${+m[3]} ${months[+m[2] - 1]}${withYear ? ` ${m[1]}` : ''}`
}
