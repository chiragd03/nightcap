// Trailers in Home's hero, in
// YouTube's own player. The Android TV finds the trailer's files itself (NewPipe) and plays them;
// a TV web app can't, so it embeds YouTube's player, which the server allows on /app/tv/ only
// (its script from www.youtube.com, its frame from www.youtube.com or www.youtube-nocookie.com).

declare global {
  interface Window { YT?: YTApi; onYouTubeIframeAPIReady?: () => void }
}

export type YTPlayer = {
  playVideo(): void; getCurrentTime(): number; mute(): void; unMute(): void; setVolume(v: number): void; getVolume(): number
  loadVideoById(o: { videoId: string; startSeconds?: number }): void; destroy(): void
}
type YTApi = { Player: new (el: HTMLElement, opts: Record<string, unknown>) => YTPlayer; PlayerState: { PLAYING: number; ENDED: number } }

let loading: Promise<YTApi | null> | null = null

/** YouTube's player API, loaded once (null if it can't be: offline, or blocked). */
export function youtube(): Promise<YTApi | null> {
  if (loading) return loading
  loading = new Promise(resolve => {
    if (window.YT?.Player) return resolve(window.YT)
    const give = setTimeout(() => { loading = null; resolve(null) }, 15000)
    const was = window.onYouTubeIframeAPIReady
    window.onYouTubeIframeAPIReady = () => { clearTimeout(give); was?.(); resolve(window.YT ?? null) }
    const s = document.createElement('script')
    s.src = 'https://www.youtube.com/iframe_api'
    s.onerror = () => { clearTimeout(give); loading = null; resolve(null) }
    document.head.appendChild(s)
  })
  return loading
}

// ---------- Trailer sound: one setting for the whole TV, on by default ----------

const MUTED = 'nightcap.tv.trailersMuted'
const listeners = new Set<(muted: boolean) => void>()

export const sound = {
  muted(): boolean {
    try { return localStorage.getItem(MUTED) === '1' } catch { return false }
  },
  toggle() {
    const m = !sound.muted()
    try { localStorage.setItem(MUTED, m ? '1' : '0') } catch { /* storage blocked: this time only */ }
    listeners.forEach(fn => fn(m))
  },
  watch(fn: (muted: boolean) => void) {
    listeners.add(fn)
    return () => { listeners.delete(fn) }
  },
}

/** "Quiet enough to talk over": the Android TV's 0.1 (about -20 dB), on YouTube's 0-100 scale. */
export const VOLUME = 10

// A trailer that failed twice isn't tried again for 10 minutes.
const failed = new Map<string, number>()
export const failedRecently = (key: string) => (failed.get(key) ?? 0) > Date.now() - 10 * 60_000
export const markFailed = (key: string) => failed.set(key, Date.now())
