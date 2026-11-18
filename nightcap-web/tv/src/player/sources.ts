// The play answer's types as the Samsung/LG app reads them, and the player's clock. Which source plays,
// and everything said about it, is the shared session's (src/player/session.ts).

import type { Play as WebPlay, Stream as WebStream, Subtitle } from '../../../src/types'

export type { Subtitle }
/** A source, with its release group (the server sends it; the web app doesn't use it). */
export type Stream = WebStream & { group?: string | null }
/** The play answer, with when its links stop working (epoch ms). */
export type Play = Omit<WebPlay, 'streams'> & { streams: Stream[]; linksExpireAt?: number }

export const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`
}
