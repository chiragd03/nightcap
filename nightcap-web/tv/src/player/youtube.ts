import { youtube } from '../home/trailer'
import type { Engine, Events, Fit, Track } from './engine'

// YouTube videos from an add-on (a source with a YouTube id and no address), in YouTube's own player,
// behind the same Engine as the TV's: so the player's controls, resume, saving and Up next work on
// them unchanged. YouTube's player has no audio or subtitle tracks to offer; Picture scales its frame.
//
// The frame is made here, not by YouTube's script, so it can say where it's embedded from: the server
// sends Referrer-Policy: no-referrer, and YouTube's player refuses to play without one (its error 153).
// It never takes the remote's focus or clicks.

type YTPlayer = {
  playVideo(): void; pauseVideo(): void; seekTo(s: number, allowAhead: boolean): void
  getCurrentTime(): number; getDuration(): number; getPlayerState(): number; setVolume(v: number): void; destroy(): void
}

const ENDED = 0, PLAYING = 1, PAUSED = 2
/** Picture for YouTube's player, which draws the video inside its frame with bars of its own and doesn't
 * say its shape: left as YouTube fits it (scaling the frame would crop or distort a 16:9 video). */
const FRAME_FIT: Record<Fit, string> = { fit: '', fill: '', stretch: '' }

export class YouTubeEngine implements Engine {
  private box: HTMLElement
  private e: Events
  private frame: HTMLIFrameElement | null = null
  /** YouTube's player, once ready (its methods aren't there before). */
  private player: YTPlayer | null = null
  /** YouTube's player as made, to be destroyed even before it's ready. */
  private made: YTPlayer | null = null
  private ticker: ReturnType<typeof setInterval> | undefined
  private opened = 0
  private last = -1
  /** Paused, as last asked or seen: YouTube's own state follows a moment after play() or pause(). */
  private held = false
  private volume = 100
  private startedSent = false
  private lastLength = 0
  private fit: Fit = 'fit'

  constructor(box: HTMLElement, events: Events) {
    this.box = box
    this.e = events
  }

  /** [url] is the video's YouTube id. */
  open(id: string, startMs: number) {
    this.stop()
    const seq = ++this.opened
    this.last = -1
    this.held = false
    this.startedSent = false
    this.lastLength = 0
    const frame = document.createElement('iframe')
    frame.className = 'player-yt'
    frame.tabIndex = -1
    frame.setAttribute('allow', 'autoplay; encrypted-media')
    frame.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin')
    const vars: Record<string, string> = {
      enablejsapi: '1', autoplay: '1', controls: '0', rel: '0', iv_load_policy: '3', playsinline: '1',
      modestbranding: '1', disablekb: '1', fs: '0', cc_load_policy: '0', origin: location.origin,
    }
    if (startMs > 0) vars.start = String(Math.floor(startMs / 1000))
    frame.src = `https://www.youtube.com/embed/${encodeURIComponent(id)}?${Object.keys(vars).map(k => `${k}=${encodeURIComponent(vars[k])}`).join('&')}`
    frame.style.transform = FRAME_FIT[this.fit]
    this.box.appendChild(frame)
    this.frame = frame
    youtube().then(YT => {
      if (seq !== this.opened) return
      if (!YT) return this.e.error("YouTube's player didn't load")
      const made = new YT.Player(frame as unknown as HTMLElement, {
        events: {
          onReady: () => {
            if (seq !== this.opened) return
            this.player = made as unknown as YTPlayer
            this.player.setVolume(this.volume)
            // (Asked again: autoplay alone isn't always honoured.)
            this.player.playVideo()
            // Its state looked at every half second too: a change before this was listening (it often
            // starts playing first) is never sent again.
            this.ticker = setInterval(() => {
              const now = this.player?.getPlayerState()
              if (now != null) this.state(now)
              if (now === PLAYING) {
                this.e.time(this.time())
                // (Its length as it changes: an ad first says the ad's.)
                const len = this.length()
                if (len > 0 && len !== this.lastLength) { this.lastLength = len; this.e.length(len) }
              }
            }, 500)
          },
          onStateChange: (ev: { data: number }) => { if (seq === this.opened) this.state(ev.data) },
          // (Taken down, private, not allowed outside YouTube, or not in this country.)
          // (100, 101, 150: not available; 152, 153: not without a referrer. None plays on a retry.)
          onError: (ev: { data: number }) => {
            if (seq !== this.opened) return
            this.e.error("YouTube wouldn't play it", [100, 101, 150, 152, 153].indexOf(ev.data) >= 0 ? { retry: false } : undefined)
          },
        },
      })
      this.made = made as unknown as YTPlayer
    })
  }

  /** YouTube's player's state, told as the engine's events when it changes. */
  private state(now: number) {
    if (now === this.last) return
    this.last = now
    if (now === PLAYING || now === PAUSED) this.held = now === PAUSED
    if (now === PLAYING) {
      const len = this.length()
      if (len > 0) { this.lastLength = len; this.e.length(len) }
      this.e.playing()
      // (YouTube's PLAYING is its picture up.)
      if (!this.startedSent) { this.startedSent = true; this.e.started?.() }
    } else if (now === PAUSED) this.e.paused()
    else if (now === ENDED) this.e.ended()
  }

  play() { this.held = false; this.player?.playVideo() }
  pause() { this.held = true; this.player?.pauseVideo() }
  isPaused() { return this.held }
  seek(ms: number) { this.player?.seekTo(ms / 1000, true) }
  time() { return (this.player?.getCurrentTime() ?? 0) * 1000 }
  length() { return (this.player?.getDuration() ?? 0) * 1000 }
  buffered() { return 0 }
  audioTracks(): Track[] { return [] }
  currentAudio() { return null }
  selectAudio() { return false }
  textTracks(): Track[] { return [] }
  currentText() { return null }
  selectText() { /* none */ }
  setVolume(v: number) { this.volume = Math.round(Math.max(0, Math.min(1, v)) * 100); this.player?.setVolume(this.volume) }
  setFit(fit: Fit) {
    this.fit = fit
    if (this.frame) this.frame.style.transform = FRAME_FIT[fit]
  }
  stop() {
    this.opened++
    clearInterval(this.ticker)
    try { this.made?.destroy() } catch { /* already gone */ }
    this.made = null
    this.player = null
    this.frame?.remove()
    this.frame = null
  }
  destroy() { this.stop() }
}

/** The TV's engine for files and links, and YouTube's player for YouTube videos: whichever the source
 * opened last needs. The other is stopped. */
export class WithYouTube implements Engine {
  private plain: Engine
  private yt: YouTubeEngine
  private on: Engine

  constructor(plain: Engine, box: HTMLElement, events: Events) {
    this.plain = plain
    this.yt = new YouTubeEngine(box, events)
    this.on = plain
  }

  open(url: string, startMs: number, hls?: boolean, youtubeId?: string, hlsConfig?: object) {
    const next = youtubeId ? this.yt : this.plain
    if (next !== this.on) this.on.stop()
    this.on = next
    if (youtubeId) this.yt.open(youtubeId, startMs)
    else this.plain.open(url, startMs, hls, undefined, hlsConfig)
  }
  play() { this.on.play() }
  pause() { this.on.pause() }
  isPaused() { return this.on.isPaused() }
  seek(ms: number) { this.on.seek(ms) }
  time() { return this.on.time() }
  length() { return this.on.length() }
  buffered() { return this.on.buffered() }
  audioTracks() { return this.on.audioTracks() }
  currentAudio() { return this.on.currentAudio() }
  selectAudio(id: string) { return this.on.selectAudio(id) }
  textTracks() { return this.on.textTracks() }
  currentText() { return this.on.currentText() }
  selectText(id: string | null) { this.on.selectText(id) }
  setVolume(v: number) { this.on.setVolume(v); this.yt.setVolume(v) }
  setFit(fit: Fit) { this.plain.setFit(fit); this.yt.setFit(fit) }
  stop() { this.on.stop() }
  destroy() { this.yt.destroy(); this.plain.destroy() }
}
