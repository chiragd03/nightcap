// Which sources this browser can play. Most releases are MKV with Dolby or DTS sound: Chromium
// shows the picture of an MKV but can't decode that sound, and Safari can't open MKV at all. So
// each source is judged from its file name before trying it, and only the likely ones are tried
// on their own. A source the server converted for browsers (webUrl) always counts as playable.

import type { Stream } from './types'

export type Fit = 'yes' | 'maybe' | 'no'

const probe = document.createElement('video')
const can = (type: string) => probe.canPlayType(type) !== ''

const chromium = 'chrome' in window
const support = {
  // Chromium plays Matroska as WebM when the codecs inside are ones it knows.
  mkv: chromium,
  avc: can('video/mp4; codecs="avc1.640028"'),
  hevc: can('video/mp4; codecs="hvc1.1.6.L120.90"') || can('video/mp4; codecs="hev1.1.6.L120.90"'),
  av1: can('video/mp4; codecs="av01.0.08M.08"'),
  ac3: can('audio/mp4; codecs="ac-3"'),
  eac3: can('audio/mp4; codecs="ec-3"'),
}

function container(s: Stream) {
  // (The file name's ending, else the address's: a direct source's name can be "HD Server 3".)
  const path = (() => { try { return new URL(s.url ?? '').pathname } catch { return '' } })()
  const ext = s.filename.toLowerCase().match(/\.(\w{2,4})$/)?.[1] ?? path.toLowerCase().match(/\.(\w{2,4})$/)?.[1]
  return ext ?? 'unknown'
}

// The file name says more than the add-on's label (which sometimes guesses).
function audioOf(s: Stream) {
  const n = `${s.filename} ${s.audio ?? ''}`.toLowerCase().replace(/[._]/g, ' ')
  if (/truehd|atmos/.test(n)) return 'truehd'
  if (/dts/.test(n)) return 'dts'
  if (/\baac|\bopus|\bmp3|\bflac/.test(n)) return 'aac'
  if (/ddp|dd\+|e-?ac-?3/.test(n)) return 'eac3'
  if (/\bac-?3\b|\bdd ?[25]|\bdd\b/.test(n)) return 'ac3'
  return 'unknown'
}

// Dolby Vision alone (profile 5) has no picture a browser can show; "DV HDR" / "DV HDR10+" files
// (profile 8, the usual WEB-DL) carry an HDR10 picture underneath, which plays as plain HDR.
const dolbyVisionOnly = (s: Stream) => s.hdr.includes('DV') && !s.hdr.some(h => h === 'HDR' || h === 'HDR10+')

function videoOk(s: Stream) {
  if (s.video === 'HEVC') return support.hevc
  if (s.video === 'AV1') return support.av1
  if (s.video === 'VC-1' || s.video === 'MPEG-2') return false
  return support.avc
}

function soundOk(audio: string) {
  if (audio === 'aac') return true
  if (audio === 'eac3') return support.eac3
  if (audio === 'ac3') return support.ac3
  if (audio === 'dts' || audio === 'truehd') return false
  return undefined // can't tell
}

/** How likely this browser is to play a source with sound. */
/** An HLS stream: the server says so (hls), as the address a player gets is a playback link that
 * doesn't. Played with hls.js, so a page has to be allowed to read it (CORS). */
export const isHls = (s: Stream) => s.hls === true || /\.m3u8($|\?)/i.test(s.url ?? '')
// hls.js wherever it can run (Media Source Extensions): newer Chrome says it plays HLS itself, but its
// own player fails on streams hls.js plays. The browser's own only where hls.js can't (iPhone Safari).
export const hlsJsOk = typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E,mp4a.40.2"')
const hlsOk = hlsJsOk || can('application/vnd.apple.mpegurl')

export function fit(s: Stream): Fit {
  // (A YouTube video plays in YouTube's own player, anywhere.)
  if (s.youtube) return 'yes'
  if (isHls(s)) return s.browser === false || !hlsOk ? 'no' : 'yes'
  if (s.webUrl) return 'yes'
  const box = container(s)
  const boxOk = box === 'mp4' || box === 'm4v' || box === 'webm' || (box === 'mkv' && support.mkv)
  if (!boxOk || !videoOk(s) || dolbyVisionOnly(s)) return 'no'
  const sound = soundOk(audioOf(s))
  return sound === true ? 'yes' : sound === false ? 'no' : 'maybe'
}

/** Whether this browser plays the smart way (smartplay.ts). Chromium only (Chrome, Edge): it's the
 * browser it's been tried in, and the one that needs it most (it can't pick an audio track, nor decode
 * Dolby or DTS). Safari and Firefox play the plain way. */
export const smartSupported = () =>
  chromium && typeof MediaSource !== 'undefined' && typeof AudioDecoder !== 'undefined' && typeof AudioEncoder !== 'undefined'

/** Whether the smart path (smartplay.ts: the page reads the file itself) can fix what keeps this
 * file from playing here: sound the browser can't decode (Dolby, DTS) or a container it can't open.
 * Not TrueHD (no decoder for it yet), nor video the browser can't show. */
export function smartFit(s: Stream) {
  if (s.youtube || s.webUrl || isHls(s) || !smartSupported()) return false
  const box = container(s)
  if (!(box === 'mp4' || box === 'm4v' || box === 'mkv' || box === 'webm') || !videoOk(s) || dolbyVisionOnly(s)) return false
  return !/truehd/i.test(`${s.filename} ${s.audio ?? ''}`)
}

/** Why a source won't play here, in a few words for the source list. */
export function whyNot(s: Stream) {
  // (One plain line the viewer can act on, never a codec or file type.)
  if (s.youtube) return undefined
  if (isHls(s)) return s.browser === false ? PLAYS_ON_TV : hlsOk ? undefined : DOESNT_PLAY_HERE
  const box = container(s)
  if (!(box === 'mp4' || box === 'm4v' || box === 'webm' || (box === 'mkv' && support.mkv))) return DOESNT_PLAY_HERE
  if (!videoOk(s)) return DOESNT_PLAY_HERE
  if (soundOk(audioOf(s)) === false) return DOESNT_PLAY_HERE
  return undefined
}

const DOESNT_PLAY_HERE = 'Doesn\'t play in this browser'
const PLAYS_ON_TV = 'Doesn\'t play in this browser · Plays on the TV app'

/** The address to play: the browser-ready version when the server has one. */
export const playUrl = (s: Stream) => s.webUrl ?? s.url
