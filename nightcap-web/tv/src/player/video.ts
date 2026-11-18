import { describe, type Engine, type Events, type Fit, type Track } from './engine'

// The <video> element (LG, and a browser while developing). It plays what the TV's (or browser's)
// own decoders can; audio tracks where the engine lists them (webOS does for many files; desktop
// Chrome doesn't). Subtitles inside the file come through its text tracks, as lines (drawn by the
// player, so their timing can be moved).

type AudioTrackList = { length: number; [i: number]: { id: string; label: string; language: string; enabled: boolean }; onchange: unknown; onaddtrack: unknown }

const MSE = typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E,mp4a.40.2"')

export class VideoEngine implements Engine {
  private v: HTMLVideoElement
  private e: Events
  private started = false
  private textId: string | null = null
  // hls.js, for an HLS stream (loaded only then): the TV's own player plays HLS, but not every stream it
  // gets (nor the simulator's), as on the web. Played through Media Source Extensions, which webOS has.
  private hls: { destroy(): void } | null = null
  private opened = 0
  /** Where the file opened last should start (s), 0 from the start; whether that seek was asked, landed,
   * and was put right once (a platform player may drop a seek asked at loadedmetadata). */
  private resumeAt = 0
  private seekAsked = false
  private seekLanded = true
  private reSeeked = false
  /** "Started" for the file opened last (once): from where its time is counted, and whether it has
   * played a frame. */
  private startedSent = false
  private base: number | null = null
  private playingSeen = false

  constructor(box: HTMLElement, events: Events) {
    this.e = events
    const v = document.createElement('video')
    v.className = 'player-video'
    v.preload = 'auto'
    v.setAttribute('playsinline', '')
    box.appendChild(v)
    this.v = v
    v.addEventListener('playing', () => { this.started = true; this.playingSeen = true; events.playing() })
    // (Chromium pauses just before it ends: that's the end, not a pause.)
    v.addEventListener('pause', () => { if (!v.ended) events.paused() })
    v.addEventListener('waiting', () => events.waiting?.())
    v.addEventListener('timeupdate', () => { events.time(v.currentTime * 1000); this.startedYet() })
    // The resume seek, for the file opened last only (never one opened before it).
    v.addEventListener('loadedmetadata', () => {
      if (this.resumeAt > 0 && !this.seekAsked) { this.seekAsked = true; v.currentTime = this.resumeAt }
    })
    v.addEventListener('seeked', () => {
      if (this.resumeAt > 0 && this.seekAsked && !this.seekLanded) { this.seekLanded = true; this.base = null }
    })
    // (A platform player that ignored the seek: once more, at the first canplay after it, before the file
    // has started. Never later: canplay comes again after every seek and stall, mid-film.)
    v.addEventListener('canplay', () => {
      if (this.resumeAt <= 0 || !this.seekAsked || this.reSeeked || this.startedSent) return
      this.reSeeked = true
      if (Math.abs(v.currentTime - this.resumeAt) > 5) v.currentTime = this.resumeAt
    })
    v.addEventListener('durationchange', () => { if (isFinite(v.duration) && v.duration > 0) events.length(v.duration * 1000) })
    v.addEventListener('progress', () => {
      if (this.started || !v.buffered.length || !isFinite(v.duration) || v.duration <= 0) return
      events.buffering(Math.min(100, Math.round((v.buffered.end(v.buffered.length - 1) - v.currentTime) / 4 * 100)))
    })
    v.addEventListener('ended', () => events.ended())
    v.addEventListener('error', () => events.error('couldn\'t be opened'))
    const tracksChanged = () => events.tracks()
    const at = (v as unknown as { audioTracks?: AudioTrackList }).audioTracks
    if (at) { at.onaddtrack = tracksChanged; at.onchange = tracksChanged }
    v.textTracks.onaddtrack = tracksChanged
  }

  open(url: string, startMs: number, hls = false, _youtube?: string, hlsConfig?: object) {
    this.started = false
    this.textId = null
    const seq = ++this.opened
    this.hls?.destroy()
    this.hls = null
    this.resumeAt = startMs > 0 ? startMs / 1000 : 0
    this.seekAsked = false
    this.seekLanded = !(startMs > 0)
    this.reSeeked = false
    this.startedSent = false
    this.base = null
    this.playingSeen = false
    // (Settings of a stream handler's own need hls.js: without Media Source, it can't play here.)
    if (hlsConfig && !MSE) { this.e.error("couldn't be opened"); return }
    if ((hls || hlsConfig) && MSE) {
      // (The last file stops now, not once hls.js has loaded: no sound behind the loading screen, none
      // of its events after this.)
      this.v.pause()
      this.v.removeAttribute('src')
      this.v.load()
      import('hls.js').then(({ default: Hls }) => {
        if (seq !== this.opened) return
        const h = new Hls({ maxBufferLength: 30, ...hlsConfig })
        h.on(Hls.Events.ERROR, (_e, data) => { if (data.fatal && seq === this.opened) this.e.error("couldn't be opened") })
        h.loadSource(url)
        h.attachMedia(this.v)
        this.hls = h
        this.v.play().catch(() => { /* the error event says why */ })
      }, () => { if (seq === this.opened) this.e.error("couldn't be opened") })
      return
    }
    this.v.src = url
    this.v.play().catch(() => { /* the error event says why */ })
  }
  /**
   * Started, the Android TV's way: the picture is up (a frame played and the time moving a little), or the
   * time has moved 1.5 s. Counted from the first time after the resume seek landed (or from the start
   * when there's none), only while not seeking; a jump over 2 s starts the count again.
   */
  private startedYet() {
    const v = this.v
    if (this.startedSent || !this.seekLanded || v.seeking) return
    const t = v.currentTime
    if (this.base == null || t < this.base || t - this.base > 2) { this.base = t; return }
    const moved = t - this.base
    if ((this.playingSeen && v.readyState >= 2 && moved > 0.3) || moved >= 1.5) {
      this.startedSent = true
      this.e.started?.()
    }
  }

  play() { this.v.play().catch(() => {}) }
  pause() { this.v.pause() }
  isPaused() { return this.v.paused }
  seek(ms: number) { this.v.currentTime = ms / 1000 }
  time() { return this.v.currentTime * 1000 }
  length() { return isFinite(this.v.duration) ? this.v.duration * 1000 : 0 }
  buffered() {
    const b = this.v.buffered
    let total = 0
    for (let i = 0; i < b.length; i++) total += b.end(i) - b.start(i)
    return total
  }

  audioTracks(): Track[] {
    const at = (this.v as unknown as { audioTracks?: AudioTrackList }).audioTracks
    const out: Track[] = []
    if (!at) return out
    for (let i = 0; i < at.length; i++) out.push({ id: String(i), ...describe(at[i].label || at[i].language, at[i].language), title: at[i].label || undefined })
    return out
  }
  currentAudio() {
    const at = (this.v as unknown as { audioTracks?: AudioTrackList }).audioTracks
    if (!at) return null
    for (let i = 0; i < at.length; i++) if (at[i].enabled) return String(i)
    return null
  }
  selectAudio(id: string) {
    const at = (this.v as unknown as { audioTracks?: AudioTrackList }).audioTracks
    if (!at || !at[Number(id)]) return false
    for (let i = 0; i < at.length; i++) at[i].enabled = String(i) === id
    // (Read back: a platform player may not take it.)
    return !!at[Number(id)]?.enabled
  }

  textTracks(): Track[] {
    const out: Track[] = []
    const tt = this.v.textTracks
    for (let i = 0; i < tt.length; i++) {
      if (tt[i].kind !== 'subtitles' && tt[i].kind !== 'captions') continue
      out.push({ id: String(i), ...describe(tt[i].label || tt[i].language, tt[i].language), title: tt[i].label || undefined })
    }
    return out
  }
  currentText() { return this.textId }
  selectText(id: string | null) {
    const tt = this.v.textTracks
    this.textId = id
    for (let i = 0; i < tt.length; i++) {
      const t = tt[i]
      // (Hidden, not shown: the player draws the lines itself.)
      t.mode = String(i) === id ? 'hidden' : 'disabled'
      t.oncuechange = String(i) === id ? () => {
        const cues = t.activeCues
        const text = cues && cues.length ? Array.from({ length: cues.length }, (_, k) => (cues[k] as VTTCue).text).join('\n') : null
        this.e.cue(text)
      } : null
    }
    if (id == null) this.e.cue(null)
  }
  setVolume(vol: number) { this.v.volume = Math.max(0, Math.min(1, vol)) }
  setFit(fit: Fit) { this.v.style.objectFit = fit === 'fill' ? 'cover' : fit === 'stretch' ? 'fill' : 'contain' }
  stop() {
    this.opened++
    this.resumeAt = 0
    this.startedSent = true
    this.hls?.destroy()
    this.hls = null
    this.v.pause()
    this.v.removeAttribute('src')
    this.v.load()
  }
  destroy() { this.stop(); this.v.remove() }
}
