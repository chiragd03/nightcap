// What plays the video: the Android TV uses libVLC; the Samsung and LG
// app, the <video> element (not Samsung's own AVPlay: it hasn't been tried on a Samsung TV),
// and YouTube's player for YouTube videos. The player screens only talk to this interface.

export type Track = {
  id: string
  /** As shown: the language's name, else the track's own title. */
  label: string
  /** ISO 639 code when the file says (2 or 3 letters). */
  lang?: string
  /** "SDH", "Forced", "Commentary"… when the track's title says. */
  note?: string
  /** The track's own title as the file gives it ("Hindi DD+ 5.1"), when it has one: the session reads a
   * language from it where the tag says none, or English. */
  title?: string
}

export type Fit = 'fit' | 'fill' | 'stretch'

export type Events = {
  /** First frame shown, and again after every pause. */
  playing(): void
  /** The file opened last has really started: its picture is up, or its time has moved 1.5 s (the
   * Android TV's rule). Once per open. */
  started?(): void
  paused(): void
  time(ms: number): void
  /** The length, once known (ms). */
  length(ms: number): void
  /** Before it starts: how far it's loaded (0-100, when the engine says). */
  buffering(pct: number): void
  /** It stopped to wait for more of the file (playing again says it's back). Engines that can't tell
   * (YouTube's) never say. */
  waiting?(): void
  /** The file says it's over (could also be a dropped connection: the player checks). */
  ended(): void
  /** [retry] false: this file won't play here (YouTube's "not available"), not a dropped connection. */
  error(why: string, o?: { retry?: boolean }): void
  /** The file's audio or subtitle tracks are known or changed. */
  tracks(): void
  /** A subtitle line from the file's own track (null: none showing). */
  cue(text: string | null): void
}

export interface Engine {
  /** [hls]: an HLS stream (its address, a playback link, may not say). [youtube]: a YouTube video's id
   * instead of an address (from an add-on; only the engine createEngine gives takes it). */
  open(url: string, startMs: number, hls?: boolean, youtube?: string, hlsConfig?: object): void
  play(): void
  pause(): void
  isPaused(): boolean
  seek(ms: number): void
  time(): number
  length(): number
  /** How much of the file is buffered (s, all ranges): any change counts as data arriving. 0 where the
   * engine can't tell. */
  buffered(): number
  audioTracks(): Track[]
  currentAudio(): string | null
  /** Switches the audio; whether it took (read back where the engine can tell). */
  selectAudio(id: string): boolean
  textTracks(): Track[]
  currentText(): string | null
  selectText(id: string | null): void
  setVolume(v: number): void
  setFit(fit: Fit): void
  stop(): void
  destroy(): void
}

/** "Track 1 - [English]", "SDH - [English]", "eng", "English (Forced)" → a label and a note. */
export function describe(raw: string, lang?: string): { label: string; lang?: string; note?: string } {
  const name = LANG_NAMES[(lang ?? '').toLowerCase()]
  const bracket = /\[([^\]]+)\]/.exec(raw)?.[1]
  const notes = ['SDH', 'Forced', 'Commentary', 'Signs', 'Songs'].filter(n => new RegExp(n, 'i').test(raw))
  const label = name ?? bracket ?? (raw.replace(/^Track \d+\s*-?\s*/i, '').trim() || raw || 'Track')
  return { label, lang, note: notes.join(', ') || undefined }
}

/** Language codes (2- and 3-letter) to names, as the Android TV's and a few more. */
export const LANG_NAMES: Record<string, string> = {
  en: 'English', eng: 'English', hi: 'Hindi', hin: 'Hindi', es: 'Spanish', spa: 'Spanish', fr: 'French', fre: 'French', fra: 'French',
  de: 'German', ger: 'German', deu: 'German', it: 'Italian', ita: 'Italian', pt: 'Portuguese', por: 'Portuguese',
  ja: 'Japanese', jpn: 'Japanese', ko: 'Korean', kor: 'Korean', zh: 'Chinese', chi: 'Chinese', zho: 'Chinese',
  ar: 'Arabic', ara: 'Arabic', ru: 'Russian', rus: 'Russian', nl: 'Dutch', dut: 'Dutch', nld: 'Dutch',
  ta: 'Tamil', tam: 'Tamil', te: 'Telugu', tel: 'Telugu', pa: 'Punjabi', pan: 'Punjabi', ur: 'Urdu', urd: 'Urdu',
  ml: 'Malayalam', mal: 'Malayalam', bn: 'Bengali', ben: 'Bengali', mr: 'Marathi', mar: 'Marathi', kn: 'Kannada', kan: 'Kannada',
  tr: 'Turkish', tur: 'Turkish', pl: 'Polish', pol: 'Polish', sv: 'Swedish', swe: 'Swedish', th: 'Thai', tha: 'Thai',
}

/** Which engine this TV gets, with YouTube's player beside it for YouTube videos. [hlsjs]: the page's
 * own player (hls.js) where the TV has Media Source, even on Samsung (Live TV: a stream's
 * handler may give hls.js settings, its own loaders, which only hls.js can use). */
export async function createEngine(box: HTMLElement, events: Events, hlsjs = false): Promise<Engine> {
  const { WithYouTube } = await import('./youtube')
  return new WithYouTube(await plainEngine(box, events, hlsjs), box, events)
}

async function plainEngine(box: HTMLElement, events: Events, _hlsjs: boolean): Promise<Engine> {
  const { VideoEngine } = await import('./video')
  return new VideoEngine(box, events)
}

/** No screensaver while the player is open. Samsung needs telling; LG's playing video
 * keeps it away by itself. */
export function keepAwake(on: boolean) {
  try {
    const w = window as unknown as { webapis?: { appcommon?: { setScreenSaver(state: number): void; AppCommonScreenSaverState: { SCREEN_SAVER_OFF: number; SCREEN_SAVER_ON: number } } } }
    const ac = w.webapis?.appcommon
    if (ac) ac.setScreenSaver(on ? ac.AppCommonScreenSaverState.SCREEN_SAVER_OFF : ac.AppCommonScreenSaverState.SCREEN_SAVER_ON)
  } catch { /* not on this TV */ }
}
