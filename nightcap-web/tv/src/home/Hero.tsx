import { useEffect, useRef, useState } from 'react'
import type { Item, Row } from '../feed'
import { failedRecently, markFailed, sound, VOLUME, youtube, type YTPlayer } from './trailer'

// The hero: the focused title's text, changed at once on every focus move
// (rising in over 240 ms), and its backdrop top right, swapped in once focus has rested 90 ms and
// crossfaded over 200 ms. The neighbours' backdrops are fetched ahead. Over it, the title's trailer
// once focus has rested 1.1 s.

const REST_MS = 90
/** On a title this long, the viewer is resting there, not passing through. */
const WARM_AFTER_MS = 450

export function heroText(row: Row, item: Item) {
  const eyebrow = row.id === 'featured' ? item.label ?? 'Featured' : row.title
  const big = item.name.length > 18
  if (item.type === 'tile') {
    return { eyebrow, title: item.name, big, meta: 'Browse  ·  press OK to open', reason: '', overview: item.overview ?? '' }
  }
  const meta = [item.episode, item.type === 'series' ? 'Series' : 'Film', item.year,
    item.rating && item.rating > 0 ? `★ ${item.rating.toFixed(1)}` : undefined].filter(Boolean).join('  ·  ')
  const reason = item.reason ? `✦  ${item.reason}` : item.progress && item.progress > 0.01 ? `${Math.floor(item.progress * 100)}% watched` : ''
  return { eyebrow, title: item.name, big, meta, reason, overview: item.overview ?? '' }
}

export function HeroText({ row, item, n }: { row: Row; item: Item; n: number }) {
  const t = heroText(row, item)
  return (
    <div key={n} className="hero-text">
      <span className="hero-eyebrow">{t.eyebrow}</span>
      <h1 className={`hero-title${t.big ? ' long' : ''}`}>{t.title}</h1>
      {t.meta && <span className="hero-meta">{t.meta}</span>}
      {t.reason && <span className="hero-reason">{t.reason}</span>}
      {t.overview && <span className="hero-overview">{t.overview}</span>}
    </div>
  )
}

/** The backdrop box: two pictures, the new one fading in over the old. */
export function Backdrop({ item, neighbours, onShown, active, onTrailer }: {
  item?: Item; neighbours: (Item | undefined)[]; onShown: (url: string | null) => void; active: boolean
  /** Whether a trailer is showing (it holds the featured carousel). */
  onTrailer?: (playing: boolean) => void
}) {
  const [layers, setLayers] = useState<{ url: string | null; n: number }[]>([{ url: null, n: 0 }])
  const count = useRef(0)
  useEffect(() => {
    if (!active) return
    const url = item?.backdrop ?? null
    const t = setTimeout(() => {
      setLayers(ls => (ls[ls.length - 1].url === url ? ls : [...ls.slice(-1), { url, n: ++count.current }]))
      onShown(url)
    }, REST_MS)
    // The neighbours' backdrops (big pictures for the TV to decode) wait until the viewer rests here:
    // fetched for every title passed, they make scrolling stutter.
    const warm = setTimeout(() => { for (const n of neighbours) if (n?.backdrop) new Image().src = n.backdrop }, WARM_AFTER_MS)
    return () => { clearTimeout(t); clearTimeout(warm) }
  }, [item, active])
  return (
    <div className="backdrop" aria-hidden>
      {layers.map(l => (l.url ? <img key={l.n} className="backdrop-img" src={l.url} alt="" /> : <span key={l.n} className="backdrop-img" />))}
      {active && item?.trailer && <Trailer key={`${item.id}:${item.trailer}`} videoId={item.trailer} onPlaying={onTrailer} />}
      <span className="scrim-left" />
      <span className="scrim-bottom" />
    </div>
  )
}

const TRAILER_AFTER_MS = 1100
const FADE_MS = 350
const SHOW_AT_S = 4.5

/** A trailer in YouTube's player, over the backdrop: started (hidden, silent) once focus has rested
 * 1.1 s, shown from 4.5 s in (fading in over 350 ms), its sound faded up to
 * a quiet 10 over 1.5 s (or none), faded out when it ends (no loop). An error tries once
 * more, then the backdrop stays. Unmounting (focus moved, Home covered) stops it at once. */
function Trailer({ videoId, onPlaying }: { videoId: string; onPlaying?: (playing: boolean) => void }) {
  const box = useRef<HTMLDivElement>(null)
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (failedRecently(videoId)) return
    let player: YTPlayer | null = null
    let gone = false, tries = 0, fade: ReturnType<typeof setInterval> | undefined, waitShow: ReturnType<typeof setInterval> | undefined
    const show = (on: boolean) => { setShown(on); onPlaying?.(on) }
    // The volume from where it is to [to], over [ms].
    const fadeTo = (to: number, ms: number) => {
      clearInterval(fade)
      if (!player) return
      const p = player
      if (to > 0) p.unMute()
      const from = p.getVolume?.() ?? 0, start = Date.now()
      fade = setInterval(() => {
        const k = Math.min(1, (Date.now() - start) / ms)
        p.setVolume(Math.round(from + (to - from) * k))
        if (k >= 1) { clearInterval(fade); if (to === 0) p.mute() }
      }, 50)
    }
    const start = setTimeout(async () => {
      const YT = await youtube()
      if (!YT || gone || !box.current) return
      const el = document.createElement('div')
      box.current.appendChild(el)
      player = new YT.Player(el, {
        videoId, width: '100%', height: '100%',
        // (Starts muted, which every browser lets play by itself; the sound fades up once playing.)
        playerVars: { autoplay: 1, mute: 1, start: 0, controls: 0, disablekb: 1, fs: 0, rel: 0, iv_load_policy: 3, playsinline: 1, modestbranding: 1, cc_load_policy: 0 },
        events: {
          onReady: (e: { target: YTPlayer }) => { e.target.setVolume(0); e.target.playVideo() },
          onStateChange: (e: { data: number }) => {
            if (gone) return
            if (e.data === YT.PlayerState.PLAYING) {
              // Shown at 4.5 s in: YouTube's player on a TV shows its own play/pause sign for its first
              // 4 seconds (it can't be hidden from outside its frame), and this also skips the
              // rating card, as the Android TV's start at 3 s does. Checked every 100 ms.
              clearInterval(waitShow)
              waitShow = setInterval(() => {
                if (gone || (player?.getCurrentTime?.() ?? 0) < SHOW_AT_S) return
                clearInterval(waitShow)
                show(true)
                if (!sound.muted()) fadeTo(VOLUME, 1500)
              }, 100)
            } else if (e.data === YT.PlayerState.ENDED) {
              clearInterval(fade)
              clearInterval(waitShow)
              show(false)
            }
          },
          onError: () => {
            if (gone) return
            show(false)
            if (++tries === 1) player?.loadVideoById({ videoId, startSeconds: 0 })
            else markFailed(videoId)
          },
        },
      })
      // (The frame never takes the remote's focus.)
      const frame = box.current.querySelector('iframe')
      frame?.setAttribute('tabindex', '-1')
      frame?.setAttribute('allow', 'autoplay; encrypted-media')
    }, TRAILER_AFTER_MS)
    // The sound setting followed at once: down over 400 ms, up over 1.5 s.
    const unwatch = sound.watch(m => fadeTo(m ? 0 : VOLUME, m ? 400 : 1500))
    return () => {
      gone = true
      clearTimeout(start)
      clearInterval(fade)
      clearInterval(waitShow)
      unwatch()
      onPlaying?.(false)
      try { player?.destroy() } catch { /* already gone */ }
    }
  }, [videoId])
  return <div ref={box} className={`trailer${shown ? ' shown' : ''}`} style={{ transitionDuration: `${FADE_MS}ms` }} />
}
