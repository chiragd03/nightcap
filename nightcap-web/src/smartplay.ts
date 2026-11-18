// The web player's "smart" path, for files the browser's own <video> plays wrongly: one whose first
// audio track isn't the profile's language (Chrome always plays the first), or whose sound the
// browser can't decode (Dolby AC3/E-AC3, DTS). The page reads the file itself (Mediabunny, in
// pieces over HTTP Range), copies the video as it is, takes only the audio track in the wanted
// language (decoding Dolby and DTS in WebAssembly and encoding it again as AAC or Opus when the
// browser can't play it), and hands that to the <video> as fragmented MP4 through Media Source.
//
// Nothing goes through Nightcap's server: the playback link redirects once, to the file's own
// address, and the file server has to let this page read it (CORS). When it doesn't, or anything
// here fails, the player plays the file the plain way instead.

import { ALL_FORMATS, Conversion, Input, Mp4OutputFormat, Output, StreamTarget, UrlSource, canEncodeAudio } from 'mediabunny'
import type { AudioCodec, InputAudioTrack, InputVideoTrack } from 'mediabunny'

/** How much is converted ahead of what's playing (by time, and by size: the browser's buffer holds a
 * few hundred MB at most, about 40 s of 4K), and how much already played is kept. */
const AHEAD_S = 90
const AHEAD_BYTES = 80 * 1024 * 1024
const BEHIND_S = 20

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

let dolby: Promise<void> | undefined, dts: Promise<void> | undefined
/** The Dolby (AC3, E-AC3) or DTS decoder, in WebAssembly: each loaded only when a file needs it. */
function loadDecoders(codec: AudioCodec | null) {
  if (codec === 'ac3' || codec === 'eac3') return (dolby ??= import('@mediabunny/ac3').then(m => m.registerAc3Decoder()))
  if (codec === 'dts') return (dts ??= import('@mediabunny/dts').then(m => m.registerDtsDecoder()))
  return Promise.resolve()
}


/** ISO 639-2 ("eng") or BCP 47 ("en-US") to the play answer's two letters ("en"). */
const TWO: Record<string, string> = {
  eng: 'en', spa: 'es', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de', ita: 'it', por: 'pt', rus: 'ru', jpn: 'ja',
  kor: 'ko', chi: 'zh', zho: 'zh', hin: 'hi', tam: 'ta', tel: 'te', ara: 'ar', dut: 'nl', nld: 'nl', pol: 'pl',
  tur: 'tr', ukr: 'uk', hun: 'hu', cze: 'cs', ces: 'cs', swe: 'sv', dan: 'da', nor: 'no', fin: 'fi', gre: 'el',
  ell: 'el', heb: 'he', tha: 'th', vie: 'vi', ind: 'id', mal: 'ml', kan: 'kn', ben: 'bn', mar: 'mr', pan: 'pa',
  guj: 'gu', urd: 'ur', per: 'fa', fas: 'fa',
}
export const twoLetter = (code: string) => { const base = code.toLowerCase().split('-')[0]; return TWO[base] ?? base }

/** [name]: the track's own name ("Hindi 5.1"), which some releases use instead of a language tag;
 * [convertible]: its sound can be played the smart way (as it is, or decoded here: not TrueHD). */
export type AudioInfo = { track: InputAudioTrack; language: string | null; name: string | null; codec: AudioCodec | null; channels: number
  playable: boolean; convertible: boolean }
export type Probe = { input: Input; video: InputVideoTrack | null; videoPlayable: boolean; audio: AudioInfo[]; duration: number }

/** Sound decoded here and encoded again (see from): what the browser decodes itself, and Dolby and DTS in WebAssembly. */
const CONVERTIBLE = new Set(['aac', 'opus', 'mp3', 'flac', 'vorbis', 'ac3', 'eac3', 'dts'])

/** The file's tracks, read from its start; throws when it can't be read (CORS, not a video, …). [reading]
 * gets the file's input at once, so a reading that never answers can still be stopped (dispose it). */
export async function probe(url: string, reading: (input: Input) => void = () => {}): Promise<Probe> {
  const input = new Input({ source: new UrlSource(url, { getRetryDelay: n => (n < 2 ? 1 : null) }), formats: ALL_FORMATS })
  reading(input)
  try {
    const video = await input.getPrimaryVideoTrack()
    const videoCodec = video && await video.getCodecParameterString()
    const videoPlayable = !!videoCodec && MediaSource.isTypeSupported(`video/mp4; codecs="${videoCodec}"`)
    const audio = await Promise.all((await input.getAudioTracks()).map(async track => {
      const codec = await track.getCodecParameterString()
      const lang = track.languageCode
      const playable = !!codec && MediaSource.isTypeSupported(`audio/mp4; codecs="${codec}"`)
      return {
        track, codec: track.codec, channels: track.numberOfChannels, name: track.name ?? null,
        language: lang && lang !== 'und' ? twoLetter(lang) : null,
        playable, convertible: playable || CONVERTIBLE.has(String(track.codec)) || String(track.codec).startsWith('pcm'),
      }
    }))
    return { input, video, videoPlayable, audio, duration: await input.computeDuration() }
  } catch (e) {
    input.dispose()
    throw e
  }
}

/** The audio track to play: the wanted language (or the original, or the first). */
export function pickAudio(found: Probe, want?: string | null, original?: string | null) {
  return found.audio.find(a => a.language === want) ?? found.audio.find(a => a.language === original) ?? found.audio[0]
}

/**
 * Plays [found]'s video with [audio] in [video], from [startAt] seconds. Seeking outside what's
 * converted starts the conversion again from there. Call destroy() when done.
 */
export class SmartPlayer {
  private source = new MediaSource()
  private buffer?: SourceBuffer
  private conversion?: Conversion
  private run = 0
  private stopped = false
  // What's been appended so far, for its bitrate (bytes a second).
  private bytes = 0
  private seconds = 0
  private readonly onSeeking = () => this.seeked()

  private video: HTMLVideoElement
  private found: Probe
  private audio: AudioInfo
  private onError: (e: unknown) => void

  constructor(video: HTMLVideoElement, found: Probe, audio: AudioInfo, startAt = 0, onError: (e: unknown) => void = () => {}) {
    this.video = video; this.found = found; this.audio = audio; this.onError = onError
    video.src = URL.createObjectURL(this.source)
    this.source.addEventListener('sourceopen', () => { this.source.duration = found.duration; this.from(startAt) }, { once: true })
    video.addEventListener('seeking', this.onSeeking)
  }

  /** Converts from [start] seconds on, replacing any conversion that's running. */
  private async from(start: number) {
    const run = ++this.run
    await this.conversion?.cancel().catch(() => {})
    if (this.stopped || run !== this.run) return
    try {
      await loadDecoders(this.audio.codec)
      const codec: AudioCodec = (await canEncodeAudio('aac')) ? 'aac' : 'opus'
      let mime: string | undefined
      let wrote = Promise.resolve()
      const output = new Output({
        format: new Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: 2 }),
        target: new StreamTarget(new WritableStream({
          // Each piece of fragmented MP4, in order: appended once the buffer is free, and only while
          // not too far ahead of what's playing (this is the backpressure on the conversion).
          write: async chunk => {
            if (run !== this.run) return
            mime ??= await output.getMimeType()
            wrote = wrote.then(() => this.append(chunk.data, mime!, start, run))
            await wrote
          },
        })),
      })
      const audioTrack = this.audio.track
      this.conversion = await Conversion.init({
        input: this.found.input, output,
        trim: { start },
        video: track => (track === this.found.video ? {} : { discard: true }),
        audio: track => track === audioTrack
          ? (this.audio.playable ? {} : { codec, forceTranscode: true, numberOfChannels: Math.min(2, this.audio.channels) })
          : { discard: true },
        tags: {},
        showWarnings: false,
      })
      if (!this.conversion.isValid) throw new Error(`Can't convert: ${this.conversion.discardedTracks.map(d => d.reason).join(', ')}`)
      await this.conversion.execute()
      await wrote
      if (run === this.run && this.source.readyState === 'open' && !this.buffer?.updating) this.source.endOfStream()
    } catch (e) {
      if (run === this.run && !this.stopped && (e as Error)?.name !== 'ConversionCanceledError') this.onError(e)
    }
  }

  private async append(data: Uint8Array, mime: string, start: number, run: number) {
    if (run !== this.run || this.stopped) return
    if (!this.buffer) {
      this.buffer = this.source.addSourceBuffer(mime)
      this.buffer.mode = 'segments'
    }
    const sb = this.buffer
    // A new run (after a seek): its timestamps start at 0, so they're moved to where it starts.
    if ((sb as SourceBuffer & { _run?: number })._run !== run) {
      await this.idle()
      sb.abort()
      sb.timestampOffset = start
      ;(sb as SourceBuffer & { _run?: number })._run = run
    }
    // Not too far ahead of the picture: wait while more than that is buffered past it.
    while (run === this.run && !this.stopped && this.bufferedAhead() > this.aheadLimit()) await sleep(1000)
    if (run !== this.run || this.stopped) return
    await this.evict()
    await this.idle()
    const first = !sb.buffered.length
    const before = this.bufferedEnd()
    // Full anyway: let go of more of what's been played, and wait for the picture to catch up.
    for (let tries = 0; ; tries++) {
      try {
        sb.appendBuffer(data as BufferSource)
        break
      } catch (e) {
        if ((e as DOMException).name !== 'QuotaExceededError' || tries >= 60) throw e
        await this.evict(5)
        await sleep(1000)
        if (run !== this.run || this.stopped) return
        await this.idle()
      }
    }
    await this.idle()
    this.bytes += data.byteLength
    this.seconds += Math.max(0, this.bufferedEnd() - before)
    // The first picture of a run: the video goes to where it starts (resuming, or after a seek).
    if (first && sb.buffered.length && Math.abs(this.video.currentTime - start) > 1) this.video.currentTime = sb.buffered.start(0)
  }

  private idle() {
    const sb = this.buffer
    return !sb || !sb.updating ? Promise.resolve() : new Promise<void>(r => sb.addEventListener('updateend', () => r(), { once: true }))
  }

  private bufferedEnd() {
    const b = this.buffer?.buffered
    return b && b.length ? b.end(b.length - 1) : 0
  }

  private aheadLimit() {
    const rate = this.seconds > 5 ? this.bytes / this.seconds : 0
    return rate ? Math.max(15, Math.min(AHEAD_S, AHEAD_BYTES / rate)) : AHEAD_S
  }

  private bufferedAhead() {
    const b = this.buffer?.buffered, t = this.video.currentTime
    if (!b) return 0
    for (let i = 0; i < b.length; i++) if (b.start(i) <= t + 0.5 && b.end(i) > t) return b.end(i) - t
    return 0
  }

  /** Drops what's more than [keep] seconds behind the picture. */
  private async evict(keep = BEHIND_S) {
    const sb = this.buffer, t = this.video.currentTime
    if (!sb || !sb.buffered.length || t - keep <= sb.buffered.start(0)) return
    await this.idle()
    sb.remove(0, t - keep)
    await this.idle()
  }

  private seeked() {
    const b = this.buffer?.buffered, t = this.video.currentTime
    if (b) for (let i = 0; i < b.length; i++) if (b.start(i) <= t && t < b.end(i) - 1) return
    this.from(t)
  }

  destroy() {
    this.stopped = true
    this.run++
    this.video.removeEventListener('seeking', this.onSeeking)
    this.conversion?.cancel().catch(() => {})
    // (The file's input stays: the page owns it, and switches another of its tracks on it.)
    URL.revokeObjectURL(this.video.src)
  }
}
