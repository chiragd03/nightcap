// A YouTube video (the YouTube add-on's streams: an id, no address) in YouTube's own player, made to
// look like the <video> the rest of the player works with: currentTime, duration, paused, play(),
// pause() and the same events (loadedmetadata, playing, pause, waiting, timeupdate, ended, error).
// So the player's own controls, resume, progress saving and Up next work on it unchanged.
//
// The iframe is made here, not by YouTube's script, so it can say where it's embedded from: the
// server sends Referrer-Policy: no-referrer, and YouTube's player refuses to play without a referrer
// (its error 153).

type YTPlayer = {
  playVideo(): void; pauseVideo(): void; seekTo(s: number, allowAhead: boolean): void
  getCurrentTime(): number; getDuration(): number; getPlayerState(): number
  mute(): void; unMute(): void; destroy(): void
}
type YTApi = { Player: new (el: HTMLElement | string, opts: Record<string, unknown>) => YTPlayer }
declare global { interface Window { YT?: YTApi; onYouTubeIframeAPIReady?: () => void } }

let loading: Promise<YTApi> | null = null

/** YouTube's player API, loaded once. */
function api(): Promise<YTApi> {
  if (loading) return loading
  loading = new Promise((resolve, reject) => {
    if (window.YT?.Player) return resolve(window.YT)
    const was = window.onYouTubeIframeAPIReady
    window.onYouTubeIframeAPIReady = () => { was?.(); window.YT ? resolve(window.YT) : reject(new Error('no YouTube')) }
    const s = document.createElement('script')
    s.src = 'https://www.youtube.com/iframe_api'
    s.onerror = () => { loading = null; reject(new Error("YouTube's player didn't load")) }
    document.head.appendChild(s)
  })
  return loading
}

const PLAYING = 1, PAUSED = 2, ENDED = 0, BUFFERING = 3

export class YouTubeVideo extends EventTarget {
  private player: YTPlayer | null = null
  private ticker: ReturnType<typeof setInterval> | undefined
  private gone = false
  private seekTo: number | null = null
  private wantMuted = false

  constructor(box: HTMLElement, id: string, startS: number) {
    super()
    const frame = document.createElement('iframe')
    frame.className = 'player-yt'
    frame.allow = 'autoplay; encrypted-media; fullscreen; picture-in-picture'
    frame.referrerPolicy = 'strict-origin-when-cross-origin'
    const params = new URLSearchParams({
      enablejsapi: '1', autoplay: '1', controls: '0', rel: '0', iv_load_policy: '3', playsinline: '1',
      modestbranding: '1', disablekb: '1', fs: '0', origin: location.origin, ...(startS > 0 ? { start: String(Math.floor(startS)) } : {}),
    })
    frame.src = `https://www.youtube.com/embed/${encodeURIComponent(id)}?${params}`
    box.appendChild(frame)
    api().then(YT => {
      if (this.gone) return
      this.player = new YT.Player(frame, {
        events: {
          onReady: () => {
            if (this.wantMuted) this.player?.mute()
            if (this.seekTo != null) { this.player?.seekTo(this.seekTo, true); this.seekTo = null }
            this.fire('loadedmetadata')
            // (Asked again: autoplay alone isn't always honoured.)
            this.player?.playVideo()
            // Its state looked at every half second too: a change before this was listening (it often
            // starts playing first) is never sent again.
            this.ticker = setInterval(() => {
              const now = this.player?.getPlayerState()
              if (now != null) this.state(now)
              if (now === PLAYING) this.fire('timeupdate')
            }, 500)
          },
          onStateChange: (e: { data: number }) => this.state(e.data),
          onError: () => this.fire('error'),
        },
      })
    }, () => this.fire('error'))
  }

  private fire(type: string) { if (!this.gone) this.dispatchEvent(new Event(type)) }

  private last = -1

  /** YouTube's player's state, told as a <video>'s events when it changes. */
  private state(s: number) {
    if (s === this.last) return
    this.last = s
    if (s === PLAYING) this.fire('playing')
    else if (s === PAUSED) this.fire('pause')
    else if (s === BUFFERING) this.fire('waiting')
    else if (s === ENDED) this.fire('ended')
  }

  get currentTime() { return this.seekTo ?? this.player?.getCurrentTime() ?? 0 }
  set currentTime(s: number) {
    if (!this.player) { this.seekTo = s; return }
    this.player.seekTo(s, true)
  }
  get duration() { return this.player?.getDuration() || NaN }
  get paused() { return this.player?.getPlayerState() !== PLAYING }
  set muted(m: boolean) { this.wantMuted = m; if (m) this.player?.mute(); else this.player?.unMute() }
  play() { this.player?.playVideo(); return Promise.resolve() }
  pause() { this.player?.pauseVideo() }

  destroy() {
    this.gone = true
    clearInterval(this.ticker)
    try { this.player?.destroy() } catch { /* already gone */ }
  }
}
