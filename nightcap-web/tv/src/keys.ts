// The remote's keys as the app's own words. Samsung sends Back as 10009 and LG as 461; a desktop
// browser uses Escape (or Backspace outside a text field). The media keys: Samsung's codes once
// registered (platform.registerKeys), LG's and the browser's names.

export type Key = 'up' | 'down' | 'left' | 'right' | 'ok' | 'back'
  | 'playpause' | 'play' | 'pause' | 'stop' | 'ff' | 'rw' | 'next' | 'prev' | 'chup' | 'chdown'

const BY_CODE: Record<number, Key> = {
  37: 'left', 38: 'up', 39: 'right', 40: 'down', 13: 'ok',
  10009: 'back', 461: 'back', 27: 'back',
  10252: 'playpause', 415: 'play', 19: 'pause', 413: 'stop', 417: 'ff', 412: 'rw', 10233: 'next', 10232: 'prev',
  // (Channel up and down: LG's page keys, Samsung's own once registered.)
  33: 'chup', 34: 'chdown', 427: 'chup', 428: 'chdown',
  // (Some Samsung on-screen keyboards finish with Done.)
  65376: 'ok',
}
const BY_NAME: Record<string, Key> = {
  ArrowLeft: 'left', ArrowUp: 'up', ArrowRight: 'right', ArrowDown: 'down', Enter: 'ok', Escape: 'back',
  MediaPlayPause: 'playpause', MediaPlay: 'play', MediaPause: 'pause', MediaStop: 'stop',
  MediaFastForward: 'ff', MediaRewind: 'rw', MediaTrackNext: 'next', MediaTrackPrevious: 'prev',
}

const typing = (el: Element | null) => el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement

export function keyOf(e: KeyboardEvent): Key | null {
  if (e.key === 'Backspace') return typing(document.activeElement) ? null : 'back'
  return BY_NAME[e.key] ?? BY_CODE[e.keyCode] ?? null
}
