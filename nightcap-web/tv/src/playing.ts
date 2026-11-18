// What's playing now (each player registers itself): Play on TV pauses it while it asks, carries on
// after "Not now", and closes it before playing what was sent (its place saved under
// the profile that watched it). While it asks, its keys are the question's.

import { keepAwake } from './player/engine'

type Playing = { pause(): boolean; resume(): void; close(): void }
let current: Playing | null = null
let asking = false
/** Registers what's playing now. The returned function unregisters it, and only it: a screen being
 * replaced stays mounted a moment (nav.tsx) and goes after the next player has registered. */
export function setPlaying(p: Playing): () => void {
  current = p
  return () => { if (current === p) current = null }
}

// The screen held for playing (no screensaver; the page see-through where the picture shows), counted:
// the player going away a moment after the next one came doesn't let go of the next one's.
let awake = 0, seeThrough = 0
/** Keeps the screensaver away while held; let go with the returned function (once). */
export function holdAwake(): () => void {
  if (awake++ === 0) keepAwake(true)
  let done = false
  return () => { if (done) return; done = true; if (--awake === 0) keepAwake(false) }
}
/** The page see-through (Samsung's video plane under it) while held; let go with the returned function. */
export function holdSeeThrough(): () => void {
  if (seeThrough++ === 0) { document.body.classList.add('playing'); document.documentElement.classList.add('playing') }
  let done = false
  return () => {
    if (done) return
    done = true
    if (--seeThrough === 0) { document.body.classList.remove('playing'); document.documentElement.classList.remove('playing') }
  }
}
/** Pauses what's playing; true if it was playing (so it's resumed after). */
export const pauseForQuestion = () => { asking = true; return current?.pause() ?? false }
export const resumeAfterQuestion = () => current?.resume()
/** The question is gone (answered or not). */
export const questionClosed = () => { asking = false }
/** Play on TV is asking over what's playing: the remote's keys are the question's. */
export const isAsking = () => asking
/** Closes what's playing, saving where it got to, and its screen with it. */
export const closePlaying = () => current?.close()
export const isPlaying = () => !!current
