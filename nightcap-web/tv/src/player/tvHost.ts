// The Samsung/LG app's side of the player session (session.ts's Host): its server calls, and what this
// TV can play. The session itself is the web app's.

import { askLink, linkPath } from '../../../src/player/link'
import { NOT_ON_THIS_TV, type Host } from '../../../src/player/session'
import { notOutYet } from '../../../src/player/words'
import type { Play, Stream } from '../../../src/types'
import * as api from '../api'
import { kind, type Kind } from '../platform'
import * as store from '../store'

/** How long the play answer may take: add-ons are slow (as the Android TV's). */
const PLAY_TIMEOUT_MS = 90_000

/** The play request's path (the session's: [audio] always sent, "*" for the one saved for this show). */
export function playPath(type: string, videoId: string, o: { binge?: string | null; more?: boolean; audio?: string | null }) {
  const q = [`audio=${encodeURIComponent(o.audio ?? '*')}`]
  if (o.binge) q.push(`binge=${encodeURIComponent(o.binge)}`)
  if (o.more) q.push('more=1')
  return `/launcher/play/${type}/${encodeURIComponent(videoId)}.json?${q.join('&')}`
}

/** A failed call as the session reads it: no connection at all is a TypeError, and only that (a timeout
 * or the server's answer never is). */
export function sessionError(e: unknown): unknown {
  return e instanceof api.ServerError && e.offline ? e.offline : e
}

/** What a file's name (and the server's reading of it) says of its picture: Dolby Vision, and an HDR
 * layer besides (HDR10, HDR10+, HLG). Dolby Vision without one is profile 5, Dolby Vision only. */
export function pictureOf(s: Pick<Stream, 'filename' | 'hdr'>) {
  const text = ` ${(s.filename ?? '').replace(/[._]/g, ' ')} ${(s.hdr ?? []).join(' ')} `
  const dv = /[^a-z0-9](dv|dovi|dolby ?vision)(?![a-z0-9])/i.test(text)
  const hdr = /[^a-z0-9](hdr(10)?\+?|hdr10plus|hlg)(?![a-z0-9])/i.test(text)
  return { dolbyVisionOnly: dv && !hdr }
}

/**
 * Whether this TV can play the stream at all, from what's known before opening it (no engine probe:
 * canPlayType speaks for the browser's own path, not the TV's player). Ruled out only where it would
 * play wrongly without an error: Dolby Vision only on a Samsung (wrong colours), and a plain http file
 * on the https server (blocked by Chromium 80+). YouTube and the plugins' streams play.
 */
export function canPlay(s: Stream, tv: Kind = kind, https = location.protocol === 'https:') {
  if (s.youtube || s.plugin) return true
  if (https && s.direct && /^http:/i.test(s.url ?? '')) return false
  if (tv === 'tizen' && pictureOf(s).dolbyVisionOnly) return false
  return true
}

export const tvHost: Host = {
  play: (type, videoId, o) => api.call<Play>(playPath(type, videoId, o), { timeout: PLAY_TIMEOUT_MS }),
  askLink,
  renewLinks: (token, runtimeMs) =>
    api.call<{ token: string; linksExpireAt: number }>('/launcher/play/renew', { body: { token, runtimeMs } })
      .catch(e => Promise.reject(sessionError(e))),
  audioLanguages: links =>
    api.call<{ languages: (string[] | null)[] }>('/launcher/audio-languages', { body: { links: links.map(linkPath) }, timeout: api.TIMEOUT.slow })
      .catch(e => Promise.reject(sessionError(e))),
  // (Nothing a screen shows changes: not marked changed.)
  sourceFailed: (id, addon, why, filename) =>
    api.send('/launcher/source-failed', { id, addon, error: why, ...(filename ? { filename: filename.slice(0, 300) } : {}) }),
  sourcePlayed: (id, key) => api.send('/launcher/source-played', { id, key }),
  sourceGone: (id, addon, key) => api.send('/launcher/source-failed', { id, addon: addon || '?', key, dead: true }),
  canPlay: s => canPlay(s),
  // (The TV's own player lists and switches a file's tracks where it has audioTracks; the session counts
  // a service whose files list none for their first track.)
  tracksSwitchable: () => typeof HTMLMediaElement !== 'undefined' && 'audioTracks' in HTMLMediaElement.prototype,
  nothingPlaysHere: NOT_ON_THIS_TV,
  notOutYet,
  // (Off: the TV may list its tracks in another order than the header's.)
  headerIndexes: false,
  profileKey: () => store.currentProfile.get() ?? '',
}
