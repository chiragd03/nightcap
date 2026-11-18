// The player page's own bookkeeping that isn't about a screen or a video element: shared by the web app's
// player and the Samsung/LG app's, so the two pages only wire
// their video and draw. Each part is the Android TV's rule.

import { linkPath } from './link'
import type { Session } from './session'
import type { Subtitle } from '../types'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** A track switched to is heard once playback is this far past where it switched (s). */
export const SWITCH_HEARD_S = 0.4
/** The next episode's sources are asked for this long before the end (s). */
export const PREFETCH_BEFORE_S = 180
/** Mid-film, nothing at all arriving for this long: the connection dropped (the TV's watchdog). */
export const NOTHING_ARRIVING_MS = 10_000
/** Progress saved this often while playing. */
export const SAVE_EVERY_MS = 30_000

// ---------- Subtitles ----------

/** The text of [sub] (SRT or WebVTT), through the server's link: once more a moment on after a hiccup;
 * an expired link (410) renews the play's links and asks for the same subtitles again. [gone]: the page
 * stopped wanting it. Rejects when it can't be had. */
export function subtitleText(session: Session, sub: Subtitle, gone: () => boolean): Promise<string> {
  const once = (x: Subtitle) => fetch(linkPath(x.url)).then(r => (r.ok ? r.text() : Promise.reject(r.status)))
  const get = (x: Subtitle) => once(x).catch(e => (e === 410 || gone() ? Promise.reject(e) : sleep(3_000).then(() => once(x))))
  return get(sub).catch(e => e === 410
    ? session.freshLinks().then(ok => {
      const again = ok && session.subtitleList().find(x => sameSubtitle(sub, x))
      return again ? get(again) : Promise.reject(e)
    })
    : Promise.reject(e))
}

/** The same subtitles (by language, release and add-on: their links change when renewed). */
export const sameSubtitle = (a: Subtitle | null, b: Subtitle) => !!a && a.lang === b.lang && a.release === b.release && a.addon === b.addon

// ---------- Progress ----------

/** What a save carries besides the page's own fields: where, how long, real time played, the picks. */
export type ProgressPart = { position: number; duration: number; played: number; audioPick?: string; subtitlePick?: string }

/**
 * Saving where it got to: real time played counted (no pauses, no seeks), a save skipped when
 * nothing moved and no pick waits, the picks sent until a save carrying them goes through.
 */
export class Progress {
  private played = 0
  private lastTick: number | null = null
  private savedAt = -1

  /** Playback time now (s), and whether it's paused. */
  tick(nowS: number, paused: boolean) {
    if (this.lastTick != null && !paused) {
      const step = nowS - this.lastTick
      if (step > 0 && step < 2) this.played += step * 1000
    }
    this.lastTick = nowS
  }

  /** The save to send now, or null: nothing to send. [positionMs]: where it is (the session's last good
   * moment mid-switch or reconnecting); [finished]: the end reached (saved as the whole length). */
  next(session: Session, positionMs: number, durationMs: number, finished = false): ProgressPart | null {
    if (!session.hasStarted()) return null
    const duration = Math.round(durationMs)
    const position = Math.round(finished ? duration : positionMs)
    if (position <= 0 || !duration) return null
    // (Only the ending says it's finished: a place at or past the length is no place to resume.)
    if (!finished && position >= duration) return null
    if (!finished && position === this.savedAt && !session.pickWaiting()) return null
    this.savedAt = position
    const part = { position, duration, played: Math.round(this.played), ...session.picksToSend() }
    this.played = 0
    return part
  }

  /** The server's answer to a save: its picks are kept once it went through. */
  answered(session: Session, part: ProgressPart, ok: boolean) {
    if (ok) session.saved({ audioPick: part.audioPick, subtitlePick: part.subtitlePick })
  }
}

// ---------- A track switch heard ----------

/**
 * After a track switch, the video may restart its source from 0 for a moment: where it was stays put,
 * and the switch counts as heard once playback is past it (SWITCH_HEARD_S), or once the session gives up
 * waiting (its 5 s). A seek of yours, or another file, ends it.
 */
export class SwitchMark {
  private from: number | null = null
  set(atS: number) { this.from = atS }
  clear() { this.from = null }
  get active() { return this.from != null }

  /** Playback time now (s): whether the session should take it as where it is. */
  time(session: Session, nowS: number): boolean {
    if (this.from != null && !session.isSwitching()) this.from = null
    if (this.from == null) return true
    if (nowS >= this.from + SWITCH_HEARD_S) { this.from = null; session.switched(); return true }
    return false
  }
}

// ---------- The watchdog ----------

/**
 * Mid-film, waiting, with nothing at all arriving for NOTHING_ARRIVING_MS: the connection dropped, though
 * the video may never say so (the Android TV's watchdog). [arrived] reports how much is buffered (any
 * change counts as arriving); [act] false only logs (the TVs, until a real TV shows its signals).
 */
export function watchdog(o: { arrived: () => number; switching: () => boolean; fail: () => void; act?: boolean }) {
  let last = Date.now(), buffered = -1
  const t = setInterval(() => {
    const total = o.arrived()
    if (total !== buffered || o.switching()) { buffered = total; last = Date.now() }
    if (Date.now() - last > NOTHING_ARRIVING_MS) {
      clearInterval(t)
      if (o.act === false) console.info('[player] nothing arriving for 10 s (logged only)')
      else o.fail()
    }
  }, 2_000)
  return {
    /** Playback moved, or data came: arriving. */
    arriving: () => { last = Date.now() },
    stop: () => clearInterval(t),
  }
}

/** Near the end: the next episode's sources asked for ahead (once; the session keeps it). */
export function nearEnd(session: Session, nextId: string | null | undefined, leftS: number) {
  if (nextId && session.isStarted() && leftS <= PREFETCH_BEFORE_S) session.prefetchNext(nextId)
}
