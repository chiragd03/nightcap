import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import * as api from '../api'
import { fit, hlsJsOk, isHls, smartSupported } from '../compat'
import type { AudioInfo, Probe } from '../smartplay'
import BackButton from '../components/BackButton'
import Icon from '../components/Icon'
import type { IconName } from '../icons'
import PlayOnTv from '../components/PlayOnTv'
import {
  BACK_NOTE_MS, NOT_IN_BROWSER, OTHER_EPISODES, COULDNT_PLAY_NOW, QUALITY_NAMES, TRY_ANOTHER, Session, languageName, trackLanguages,
  type Carry, type View,
} from '../player/session'
import type { Card, Header, Play, Subtitle } from '../types'
import { YouTubeVideo } from '../youtube'
import { webHost } from '../player/webHost'
import { Progress, SAVE_EVERY_MS, SwitchMark, nearEnd, sameSubtitle as same, subtitleText, watchdog } from '../player/playback'
import { wide } from '../images'
import { playerShown } from '../appUpdate'
import './Player.css'

// The Nightcap player for the browser, as the Android TV's: a calm loading screen (the
// title's picture, its name and one line), controls over the bottom (the gold play button on the timeline,
// Audio, Subtitles, Quality, Picture, Episodes and Next), panels over the picture, and Up next near the
// end of an episode. Which file plays, and everything about trying, waiting and giving up, is the
// session's (player/session.ts); this draws it and plays what it asks for.
//
// A file is played as it is, or the smart way (smartplay.ts) when the browser would play it wrongly (its
// first audio track isn't the wanted language, or its sound or container is one the browser can't
// handle): the smart way also switches audio tracks inside a file, as the TV does.

const SOUND_CHECK_MS = 4_000     // Chromium: no sound decoded by then means it can't play the sound
const PROBE_MS = 8_000           // looking into a file takes longer than this: it's played as it is
const UP_NEXT_AT_S = 25          // the Up next card, this long before the end
const UP_NEXT_COUNT = 10
const HIDE_CONTROLS_MS = 3_000
/** A phone or tablet: taps show and hide the controls, a double tap on a side skips 10 s. (Followed as it
 * changes: a laptop turned into a tablet, a trackpad put on an iPad.) */
const coarse = typeof matchMedia === 'function' ? matchMedia('(pointer: coarse)') : null
function useTouch() {
  const [touch, setTouch] = useState(!!coarse?.matches)
  useEffect(() => {
    if (!coarse) return
    const change = () => setTouch(coarse.matches)
    coarse.addEventListener('change', change)
    return () => coarse.removeEventListener('change', change)
  }, [])
  return touch
}
/** Whether this browser lets the page itself go full screen (an iPhone doesn't). */
const CAN_FULLSCREEN = typeof document !== 'undefined' && !!document.fullscreenEnabled
const DOUBLE_TAP_MS = 280

// The smart way's code (Mediabunny) is fetched only once a player needs it, not with the app.
let smartLib: Promise<typeof import('../smartplay')> | undefined
const loadSmart = () => (smartLib ??= import('../smartplay'))

type Panel = 'audio' | 'subtitles' | 'quality' | 'picture' | 'episodes' | null
type Fit = 'contain' | 'cover' | 'fill'

/** A new player for each title (its own session): the page's state starts afresh. */
export default function Player() {
  const { type = 'movie', vid = '' } = useParams()
  useEffect(playerShown, [])
  return <PlayerView key={`${type}/${vid}`} type={type} vid={vid} />
}

function PlayerView({ type, vid }: { type: string; vid: string }) {
  const [search] = useSearchParams()
  const navigate = useNavigate()
  // The loading picture: the episode's still, else the show's backdrop; nothing when neither loads.
  const sent = useLocation().state as { art?: string; fallback?: string; carry?: Carry } | null
  // (Opened from a link or a reload, nothing was sent: the title's own name and backdrop, while it loads.)
  const [header, setHeader] = useState<Header | null>(null)
  useEffect(() => {
    if (sent?.art) return
    let off = false
    api.titlePage(type, vid.split(':')[0]).then(p => { if (!off) setHeader(p.header) }, () => {})
    return () => { off = true }
  }, [])
  const arts = [...new Set([sent?.art, sent?.fallback, header?.backdrop].filter((x): x is string => !!x))]
  const [artAt, setArtAt] = useState(0)
  const art = arts[artAt]
  const fallback = sent?.fallback

  // ---------- The session ----------

  const fresh = () => new Session(type, vid, search.get('binge'), sent?.carry ?? {}, null, webHost)
  const session = useRef<Session>(null as unknown as Session)
  if (!session.current) session.current = fresh()
  const s = session.current
  const [view, setView] = useState<View>(s.view)
  useEffect(() => {
    // (React may run this twice in development, closing the first: a closed one is made again.)
    let ses = session.current
    if (ses.isClosed()) { ses = fresh(); session.current = ses }
    ses.onChange(setView)
    api.profilePage().then(p => { const want = p.settings?.subtitles; ses.setProfileSubs(typeof want === 'string' ? want : null) }, () => {})
    void ses.load()
    return () => ses.close()
  }, [])
  const play = view.play
  const open = view.open
  // (The file playing now: more sources may have moved it in the list since it was opened.)
  const stream = open ? s.stream() : undefined

  // ---------- The video ----------

  const video = useRef<HTMLVideoElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const [paused, setPaused] = useState(false)
  const [blocked, setBlocked] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const [time, setTime] = useState(0)
  const [length, setLength] = useState(0)
  const [muted, setMuted] = useState(false)
  const [picture, setPicture] = useState<Fit>('contain')

  // How the file is played: as it is, or the smart way (its audio track chosen). Worked out before its
  // <video> is put on the page. The file's tracks, once read, stay for switching audio inside it.
  const [mode, setMode] = useState<{ attempt: number; smart?: { found: Probe; audio: AudioInfo } }>()
  const probed = useRef<{ attempt: number; found: Probe; languages: (string | null)[]; switchable: boolean[] } | null>(null)
  useEffect(() => {
    setMode(undefined)
    setBlocked(false)
    setWaiting(false)
    if (probed.current && !probed.current.found.input.disposed) probed.current.found.input.dispose()
    probed.current = null
    if (!open) return
    const st = s.stream()
    // (An HLS stream, YouTube, or no smart way here: played as it is.)
    if (!st || open.youtube || !smartSupported() || isHls(st)) { setMode({ attempt: open.attempt }); return }
    let gone = false, settled = false, reading: { dispose(): void; disposed: boolean } | undefined
    // (Looking into it took too long: played as it is; a late answer lists its tracks, and puts the wanted
    // language right if it's another of them.)
    const plain = () => { if (!gone && !settled) { settled = true; setMode({ attempt: open.attempt }) } }
    const timer = setTimeout(plain, PROBE_MS)
    loadSmart().then(lib => lib.probe(open.url, i => { reading = i })).then(f => {
      clearTimeout(timer)
      if (gone) return f.input.dispose()
      // Each track's language as the server reads it (its own name when its tag says nothing or English),
      // and which the smart way can switch to.
      const languages = trackLanguages(f.audio, st.fileAudio)
      const switchable = f.audio.map(a => f.videoPlayable && a.convertible)
      probed.current = { attempt: open.attempt, found: f, languages, switchable }
      // (The track that was playing in this very file, or a picked one carried in the same release; else the
      // wanted language, the title's own, or the first: one the smart way can play.)
      const kept = s.trackToOpen()
      const by = (code: string | null) => (code ? languages.findIndex((l, i) => l === code && (i === 0 || switchable[i])) : -1)
      const at = [kept ?? -1, by(s.wantedAudio()), by(s.originalAudio()), 0].find(i => i >= 0 && !!f.audio[i] && (i === 0 || switchable[i]))!
      if (settled) {
        s.setTracks(open.attempt, { languages, playing: 0, switchable })
        // (Playing its first track already: the wanted one, if it's another, switched to from where it is.)
        const want = by(s.wantedAudio())
        if (want > 0) s.switchTo_(languages[want]!, () => switchTrack(want))
        return
      }
      settled = true
      const audio = f.audio[at]
      const smart = f.videoPlayable && !!audio && (at !== 0 || !audio.playable || fit(st) === 'no')
      s.setTracks(open.attempt, { languages, playing: smart ? at : 0, switchable })
      setMode(smart ? { attempt: open.attempt, smart: { found: f, audio } } : { attempt: open.attempt })
    }, e => {
      clearTimeout(timer)
      // (The host sends no CORS headers: a TypeError, while online; an HTTP status was readable, so not that.)
      if (e instanceof TypeError && navigator.onLine && !/Error fetching/.test(e.message)) s.unreadable(open.attempt)
      plain()
    })
    return () => { gone = true; clearTimeout(timer); if (reading && !reading.disposed && !probed.current) reading.dispose() }
    // (The file to open, by its attempt: nothing else restarts it.)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open?.attempt])
  useEffect(() => () => { if (probed.current && !probed.current.found.input.disposed) probed.current.found.input.dispose() }, [])
  const ready = !!open && mode?.attempt === open.attempt
  const smart = ready ? mode?.smart : undefined
  // (Its time to start counts from here: looking into the file took some of it.)
  useEffect(() => { if (ready && open) s.begin(open.attempt) }, [ready, open?.attempt])

  // The smart way: Mediabunny feeds the <video> from where playback is up to. If it fails before playing,
  // the file is played as it is; after, as any file that stopped playing.
  const smartFrom = useRef(0)
  const switchMark = useRef(new SwitchMark()).current
  const stayPaused = useRef(false)
  // (Another file: no switch of the last one's under way.)
  useEffect(() => { switchMark.clear(); stayPaused.current = false }, [open?.attempt])
  useEffect(() => {
    const v = video.current
    if (!smart || !v || !open) return
    let player: { destroy(): void } | undefined, gone = false
    const from = smartFrom.current > 0 ? smartFrom.current : open.at / 1000
    smartFrom.current = 0
    const at = from < smart.found.duration - 10 ? from : 0
    loadSmart().then(lib => {
      if (gone) return
      player = new lib.SmartPlayer(v, smart.found, smart.audio, at, () => {
        if (s.isStarted()) return s.error(open.attempt, 'stopped playing (smart)')
        // (Played as it is instead: its first track is what's heard.)
        const p = probed.current
        if (p) s.setTracks(open.attempt, { languages: p.languages, playing: 0, switchable: p.switchable })
        setMode(m => (m?.smart === smart ? { attempt: open.attempt } : m))
      })
    })
    return () => { gone = true; player?.destroy() }
  }, [smart])

  /** Audio: a track of this file, switched to the smart way from where it is. */
  const switchTrack = (track: number) => {
    const p = probed.current
    const found = p?.found
    const v = video.current
    if (!p || !found || !open || !found.audio[track] || !p.switchable[track]) return false
    smartFrom.current = v?.currentTime ?? 0
    switchMark.set(smartFrom.current)
    // (Switched while paused: it stays paused once the new track is in.)
    stayPaused.current = !!v?.paused
    s.setTracks(open.attempt, { languages: p.languages, playing: track, switchable: p.switchable })
    setMode({ attempt: open.attempt, smart: { found, audio: found.audio[track] } })
    return true
  }

  // An HLS stream: hls.js feeds the <video> wherever it can run (compat.ts). A fatal error is the file failing.
  const hlsJs = ready && !!stream && isHls(stream) && hlsJsOk && !smart && !open?.youtube
  useEffect(() => {
    const v = video.current
    if (!hlsJs || !v || !open) return
    let hls: { destroy(): void } | undefined, gone = false
    import('hls.js').then(({ default: Hls }) => {
      if (gone) return
      const h = new Hls({ maxBufferLength: 30 })
      h.on(Hls.Events.ERROR, (_e, data) => { if (data.fatal && !gone) s.error(open.attempt, "couldn't be opened (hls)") })
      h.loadSource(open.url)
      h.attachMedia(v)
      hls = h
    }, () => { if (!gone) s.error(open.attempt, "couldn't be opened (hls)") })
    return () => { gone = true; hls?.destroy() }
  }, [hlsJs, open?.attempt])

  // A YouTube video: YouTube's own player, looking to the rest of the player like its <video> (youtube.ts).
  const ytBox = useRef<HTMLDivElement>(null)
  const handlers = useRef({ meta: () => {}, playing: () => {}, time: () => {}, ended: () => {}, pause: () => {}, waiting: () => {}, error: () => {} })
  const yt = ready ? open?.youtube : undefined
  useEffect(() => {
    const el = ytBox.current
    if (!yt || !el || !open) return
    const v = new YouTubeVideo(el, yt, open.at / 1000)
    ;(video as { current: unknown }).current = v
    const on = (t: string, fn: keyof typeof handlers.current) => v.addEventListener(t, () => handlers.current[fn]())
    on('loadedmetadata', 'meta'); on('playing', 'playing'); on('timeupdate', 'time'); on('ended', 'ended')
    on('pause', 'pause'); on('waiting', 'waiting'); on('error', 'error')
    return () => { v.destroy(); if ((video as { current: unknown }).current === v) (video as { current: unknown }).current = null; el.innerHTML = '' }
  }, [yt, open?.attempt])

  // ---------- Subtitles: fetched as text and handed to the video as a local file ----------

  const [subtitle, setSubtitle] = useState<Subtitle | null>(null)
  const [subtitleSrc, setSubtitleSrc] = useState<string>()
  // The subtitles wanted (picked for this show, else the profile's), once the play answer is in.
  useEffect(() => {
    if (!play) return
    const want = s.subsWant()
    setSubtitle(want === 'off' ? null : s.subtitleList().find(x => x.lang === want) ?? null)
  }, [play?.id, view.everStarted])
  useEffect(() => {
    setSubtitleSrc(undefined)
    if (!subtitle) return
    let url: string | undefined, gone = false
    subtitleText(s, subtitle, () => gone).then(text => {
      if (gone) return
      url = URL.createObjectURL(new Blob([text.startsWith('WEBVTT') ? text : srtToVtt(text)], { type: 'text/vtt' }))
      setSubtitleSrc(url)
    }).catch(() => { if (!gone) { setSubtitle(null); s.note("Couldn't load those subtitles", BACK_NOTE_MS) } })
    return () => { gone = true; if (url) URL.revokeObjectURL(url) }
  }, [subtitle])
  useEffect(() => {
    const tracks = video.current?.textTracks
    if (tracks?.[0]) tracks[0].mode = 'showing'
  }, [subtitleSrc, open?.attempt, mode])

  // ---------- Progress ----------

  const progress = useRef(new Progress()).current
  /** The file's length as it opened (a smart conversion may end the video early: not the file's end). */
  const lengthNow = useRef(0)
  /** The length of the file that last played well (s): what a save measures against while another opens. */
  const goodLength = useRef(0)
  const save = useCallback((leaving = false, finished = false) => {
    if (!play) return
    const v = video.current
    // (Mid-switch or reconnecting: where it had got to.)
    // (Measured against the file that last played well while another opens: an error clip's length
    // never makes where it got to look like the end.)
    const started = s.isStarted() && !!v
    const part = progress.next(s, started ? v.currentTime * 1000 : s.resumeFrom(), (started ? v.duration || length : goodLength.current) * 1000, finished)
    if (!part) return
    api.saveProgress({ type: play.type, id: play.id, origin: 'direct', ...part }, leaving).then(ok => progress.answered(s, part, ok))
  }, [play, length, s])
  const saveNow = useRef(save)
  saveNow.current = save
  // Handing over to another episode, or finished: its last save made; leaving doesn't overwrite it.
  const leaving = useRef(false)
  useEffect(() => {
    if (!view.everStarted) return
    const t = setInterval(() => { if (!leaving.current) saveNow.current() }, SAVE_EVERY_MS)
    const bye = () => { if (!leaving.current) saveNow.current(true) }
    window.addEventListener('pagehide', bye)
    return () => { clearInterval(t); window.removeEventListener('pagehide', bye); if (!leaving.current) saveNow.current(true) }
  }, [view.everStarted])

  // ---------- Video events ----------

  const attempt = open?.attempt ?? -1
  const onMeta = () => {
    const v = video.current!
    if (v.duration && isFinite(v.duration)) {
      // (Kept only once the session takes it: an error clip's length is never the film's.)
      s.length(attempt, v.duration * 1000)
      if (s.attemptNow() === attempt) {
        setLength(v.duration)
        lengthNow.current = v.duration
        if (s.isStarted()) goodLength.current = v.duration
      }
    }
    // (Found not to be the video, or another file opening meanwhile: this one isn't started.)
    if (s.attemptNow() !== attempt) return
    // (The smart way starts where playback is up to by itself.)
    const at = open ? open.at / 1000 : 0
    if (!smart && at > 0 && (!v.duration || at < v.duration - 10)) v.currentTime = at
    if (stayPaused.current && s.isStarted()) { stayPaused.current = false; setPaused(true); return }
    v.play().catch(e => {
      if ((e as Error).name === 'NotAllowedError') { setBlocked(true); s.blocked(attempt) }
      setPaused(true)
    })
  }
  const onPlaying = () => {
    setBlocked(false)
    setWaiting(false)
    setPaused(false)
    if (s.isStarted()) return
    s.startedPlaying(attempt, (video.current?.currentTime ?? 0) * 1000)
    if (s.isStarted()) goodLength.current = lengthNow.current || video.current?.duration || 0
    // Chromium plays an MKV's picture even when it can't decode its sound: check there's sound.
    const v = video.current as HTMLVideoElement & { webkitAudioDecodedByteCount?: number }
    const at = attempt
    setTimeout(() => {
      if (v && v.webkitAudioDecodedByteCount === 0 && !v.paused) s.error(at, 'no sound in this browser', { retry: false, network: false })
    }, SOUND_CHECK_MS)
  }
  // Mid-film, waiting with nothing arriving for a while: the connection dropped, though the browser
  // may never say so (the TV's watchdog). The same file is opened again from where it was.
  const dog = useRef<{ arriving(): void } | null>(null)
  useEffect(() => {
    if (!waiting || paused || !view.everStarted || !open) return
    const at = open.attempt
    // (Data still arriving, a slow connection, is waited for: only nothing at all for a while is a drop.)
    const d = watchdog({
      arrived: () => { const b = video.current?.buffered; let total = 0; if (b) for (let i = 0; i < b.length; i++) total += b.end(i) - b.start(i); return total },
      switching: () => switchMark.active,
      fail: () => s.error(at, 'stopped arriving'),
    })
    dog.current = d
    return () => { d.stop(); dog.current = null }
  }, [waiting, paused, view.everStarted, open?.attempt])
  const [upNext, setUpNext] = useState<number | null>(null)
  const [upNextDismissed, setUpNextDismissed] = useState(false)
  const onTime = () => {
    const v = video.current!
    const now = v.currentTime
    progress.tick(now, v.paused)
    dog.current?.arriving()
    setTime(now)
    // (Switching tracks, the video restarts its source from 0 for a moment: where it was stays.)
    if (switchMark.time(s, now)) s.time(attempt, now * 1000)
    // Up next, near the end of an episode; back out of the end, it goes (and may come again).
    const left = v.duration ? v.duration - now : Infinity
    nearEnd(s, play?.next?.id, left)
    if (play?.next && !upNextDismissed && left <= UP_NEXT_AT_S && upNext == null) setUpNext(UP_NEXT_COUNT)
    if (left > UP_NEXT_AT_S) { if (upNext != null) setUpNext(null); if (upNextDismissed) setUpNextDismissed(false) }
  }
  // (Finished only from the credits on, or Up next: Next pressed early keeps this one's place.)
  const goNext = useCallback((finished?: boolean) => {
    if (!play?.next) return
    const v = video.current
    save(false, finished ?? (!!v?.duration && v.duration - v.currentTime <= UP_NEXT_AT_S))
    leaving.current = true
    const binge = s.stream()?.bingeGroup
    navigate(`/watch/series/${play.next.id}${binge ? `?binge=${encodeURIComponent(binge)}` : ''}`,
      { replace: true, state: { art: fallback ?? art, fallback, carry: s.carry() } })
  }, [play, stream, save, navigate, art, fallback, s])
  // (Counting down only while it plays: not paused, not reconnecting.)
  useEffect(() => {
    if (upNext == null || paused || view.loading) return
    if (upNext <= 0) return goNext(true)
    const t = setTimeout(() => setUpNext(n => (n == null ? n : n - 1)), 1000)
    return () => clearTimeout(t)
  }, [upNext, paused, goNext, view.loading])
  const onEnded = () => {
    const v = video.current
    // (Where it got to before the end, against the length it opened with: a dropped stream "ends" early.)
    if (!s.ended(attempt, s.resumeFrom(), (lengthNow.current || v?.duration || length) * 1000)) return
    if (play?.next && !upNextDismissed) return goNext(true)
    save(false, true)
    setPaused(true)
  }
  const onError = () => s.error(attempt, "couldn't be opened")

  handlers.current = {
    meta: onMeta, playing: onPlaying, time: onTime, ended: onEnded, error: onError,
    pause: () => { setPaused(true); save() }, waiting: () => setWaiting(true),
  }
  useEffect(() => { if (yt && video.current) (video.current as { muted: boolean }).muted = muted }, [yt, muted])

  // ---------- Controls ----------

  const toggle = () => { const v = video.current; if (v) v.paused ? v.play()?.catch(() => {}) : v.pause() }
  const seek = (by: number) => { const v = video.current; if (v) { switchMark.clear(); v.currentTime = Math.max(0, Math.min(v.duration, v.currentTime + by)) } }
  const TOUCH = useTouch()
  const fullscreen = () => {
    // (An iPhone has no full screen for a page.)
    if (!CAN_FULLSCREEN) return
    if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); return }
    box.current?.requestFullscreen()
      // (A phone turns sideways for the film, where it can.)
      .then(() => { if (TOUCH) (screen.orientation as { lock?: (o: string) => Promise<void> })?.lock?.('landscape').catch(() => {}) })
      .catch(() => {})
  }
  const leave = () => ((window.history.state?.idx ?? 0) > 0 ? navigate(-1) : navigate('/'))
  const [panel, setPanel] = useState<Panel>(null)
  const loadingNow = useRef(true)
  loadingNow.current = view.loading
  // (A panel left open closes once the screen goes to loading: a pick then would drop a reconnect.)
  useEffect(() => { if (view.loading) setPanel(null) }, [view.loading])
  const [controls, setControls] = useState(true)
  const [onTv, setOnTv] = useState(false)
  const hideTimer = useRef(0)
  const wake = useCallback(() => {
    setControls(true)
    clearTimeout(hideTimer.current)
    hideTimer.current = window.setTimeout(() => setControls(false), HIDE_CONTROLS_MS)
  }, [])
  useEffect(() => () => clearTimeout(hideTimer.current), [])

  // A tap on the picture: with a mouse, play or pause; on a touch screen, show or hide the controls, and
  // a double tap on its left or right third skips back or on 10 s (a second double tap, 10 s more).
  const lastTap = useRef({ at: 0, side: 0 })
  const tapTimer = useRef(0)
  const [skipped, setSkipped] = useState<{ side: number; n: number } | null>(null)
  const skipTimer = useRef(0)
  useEffect(() => () => { clearTimeout(tapTimer.current); clearTimeout(skipTimer.current) }, [])
  const tap = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (loading) return
    if (!TOUCH) { toggle(); wake(); return }
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const x = (e.clientX - r.left) / r.width
    const side = x < 1 / 3 ? -1 : x > 2 / 3 ? 1 : 0
    const now = Date.now()
    const again = now - lastTap.current.at < DOUBLE_TAP_MS && side !== 0 && side === lastTap.current.side
    lastTap.current = { at: now, side }
    clearTimeout(tapTimer.current)
    if (again || (skipped && skipped.side === side && side !== 0)) {
      seek(side * 10)
      setSkipped(k => ({ side, n: k && k.side === side ? k.n + 1 : 1 }))
      clearTimeout(skipTimer.current)
      skipTimer.current = window.setTimeout(() => setSkipped(null), 700)
      return
    }
    // (Waits a moment: a second tap makes it a skip, not a show-and-hide.)
    tapTimer.current = window.setTimeout(() => {
      if (shownRef.current && !paused && !panel) { clearTimeout(hideTimer.current); setControls(false) } else wake()
    }, side === 0 ? 0 : DOUBLE_TAP_MS)
  }
  const shownRef = useRef(true)
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target?.tagName === 'INPUT') return
      // (Before the picture, only Back counts: a pause then would only look like a file that didn't start.)
      if (loadingNow.current && e.key !== 'Escape') return
      // (A card's or a panel's button takes Space and Enter itself: Space presses "Keep trying".)
      if ((e.key === ' ' || e.key === 'Enter') && target?.closest?.('.player-loading, .player-panel')) return
      wake()
      // (A held key acts once: no flicker of pause and play.)
      if (e.key === ' ' || e.key === 'k') { e.preventDefault(); if (!e.repeat) toggle() }
      else if (e.key === 'ArrowRight') seek(10)
      else if (e.key === 'ArrowLeft') seek(-10)
      else if (e.key === 'f') fullscreen()
      else if (e.key === 'm') setMuted(m => !m)
      else if (e.key === 'Escape') panel ? setPanel(null) : s.cancelSwitch() || document.fullscreenElement ? null : leave()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [panel, wake])

  // A note over the picture, for its time.
  const [note, setNote] = useState<string | null>(null)
  useEffect(() => {
    if (!view.note) return
    setNote(view.note.text)
    const t = setTimeout(() => setNote(null), view.note.ms + 400)
    return () => clearTimeout(t)
  }, [view.note?.n])

  // ---------- Drawing ----------

  const [show, epName] = splitEpisode(play)
  const loading = view.loading
  const shown = controls || paused || panel != null || loading
  shownRef.current = shown
  const isSeries = play?.type === 'series'

  return (
    <div ref={box} className={`player${shown ? '' : ' idle'}${TOUCH ? ' touch' : ''}`} onMouseMove={TOUCH ? undefined : wake} onClick={wake}>
      {yt && (
        <div key={`yt ${open?.attempt}`} ref={ytBox} className="player-video player-yt-box"
          onDoubleClick={TOUCH ? undefined : fullscreen} onClick={tap} />
      )}
      {ready && open && !open.youtube && (
        <video
          key={`${open.attempt}${smart ? ' smart' : ''}`}
          ref={video}
          className="player-video"
          style={{ objectFit: picture }}
          src={smart || hlsJs ? undefined : open.url}
          muted={muted}
          playsInline
          preload="auto"
          onLoadedMetadata={onMeta}
          onPlaying={onPlaying}
          onWaiting={() => setWaiting(true)}
          onPause={e => {
            // (The element being replaced, a smart fallback say: not a pause.)
            if (e.currentTarget !== video.current) return
            setPaused(true)
            // (Paused before the picture, by a key or the browser in a background tab: waiting for you, as a
            // blocked start, not a file that didn't start.)
            if (!s.isStarted() && s.attemptNow() === attempt) { setBlocked(true); s.blocked(attempt) }
            save()
          }}
          onPlay={() => { setPaused(false); if (blocked) { setBlocked(false); s.unblocked(attempt) } }}
          onTimeUpdate={onTime}
          onEnded={onEnded}
          onError={onError}
          onDoubleClick={TOUCH ? undefined : fullscreen}
          onClick={tap}
        >
          {subtitleSrc && <track kind="subtitles" src={subtitleSrc} srcLang={subtitle?.lang} label={subtitle?.language} default />}
        </video>
      )}

      {loading && (
        <div className="player-loading">
          {/* (Mid-film too, the title's picture behind the one line, as on the Android TV: the
              video itself is black while a file changes.) */}
          {art && <img key={art} className="player-art" {...wide(art)} alt="" onError={() => setArtAt(i => i + 1)} />}
          <div className="player-loading-card">
            <div className="eyebrow player-eyebrow">{show || (header ? (type === 'movie' ? 'Film' : header.name) : '')}</div>
            <h1>{epName || play?.name || (type === 'movie' ? header?.name : '') || ''}</h1>
            {view.card ? (
              <ChoiceCard card={view.card} onPlay={() => (view.card === 'keepTrying' ? s.keepTrying() : s.playOtherEpisodes())} onBack={leave} />
            ) : view.ended ? (
              <>
                <p className="player-note">{view.ended}</p>
                <div className="player-other">
                  <button className="btn" onClick={leave}>Back</button>
                  {play && play.releases == null && (view.ended === NOT_IN_BROWSER || play.streams.length > 0) && (
                    <button className="btn primary" onClick={() => setOnTv(true)}>Play on TV</button>
                  )}
                </div>
              </>
            ) : blocked && open ? (
              <button className="btn primary player-start" onClick={() => { video.current?.play()?.catch(() => {}); s.unblocked(open.attempt) }}>
                <Icon name="play" size={20} /> Play
              </button>
            ) : view.line ? (
              <p className="player-note breathing">{view.line}</p>
            ) : null}
          </div>
        </div>
      )}

      <div className="player-top">
        {/* (Back while switching to a version you picked: back on the one you were watching.) */}
        <div onClickCapture={e => { if (s.cancelSwitch()) { e.preventDefault(); e.stopPropagation() } }}><BackButton /></div>
      </div>

      {!loading && TOUCH && upNext == null && (
        <div className="player-center">
          <button className="player-round skip" aria-label="Back 10 seconds" onClick={() => { seek(-10); wake() }}><Skip back /></button>
          {/* (Waiting for the picture: the button turns, so a stall right after a tap shows.) */}
          <button className={`player-play big${waiting ? ' waiting' : ''}`} aria-label={paused ? 'Play' : 'Pause'} onClick={() => { toggle(); wake() }}>
            <Icon name={paused ? 'pl_play' : 'pl_pause'} size={30} />
          </button>
          <button className="player-round skip" aria-label="Forward 10 seconds" onClick={() => { seek(10); wake() }}><Skip /></button>
        </div>
      )}
      {skipped && <div className={`player-skipped ${skipped.side < 0 ? 'left' : 'right'}`} key={skipped.n}>{skipped.side < 0 ? '−' : '+'}{skipped.n * 10} s</div>}

      {!loading && (
        <div className="player-bottom">
          <div className="eyebrow player-eyebrow">{show}</div>
          <h2>{epName || play?.name}</h2>
          {stream && <div className="player-source">{releaseLine(stream)}</div>}
          <div className="player-line">
            <button className="player-play" aria-label={paused ? 'Play' : 'Pause'} onClick={toggle}>
              <Icon name={paused ? 'pl_play' : 'pl_pause'} size={22} />
            </button>
            <Timeline time={time} length={length} onActive={wake} onSeek={t => { if (video.current) { switchMark.clear(); video.current.currentTime = t } }} />
          </div>
          <div className="player-buttons">
            <Chip icon="pl_audio" label="Audio" onClick={() => setPanel('audio')} />
            <Chip icon="pl_subtitles" label="Subtitles" on={!!subtitle} onClick={() => setPanel('subtitles')} />
            <Chip icon="pl_quality" label="Quality" onClick={() => setPanel('quality')} />
            <Chip icon="pl_picture" label="Picture" onClick={() => setPanel('picture')} />
            <span className="player-spacer" />
            {isSeries && <Chip icon="pl_episodes" label="Episodes" onClick={() => setPanel('episodes')} />}
            {play?.next && <Chip icon="pl_next" label="Next episode" onClick={() => goNext()} />}
            {/* (A phone's own buttons set its sound.) */}
            {!TOUCH && (
              <button className="player-round" aria-label={muted ? 'Sound on' : 'Mute'} onClick={() => setMuted(m => !m)}>
                <Icon name={muted ? 'sound_off' : 'sound_on'} size={20} />
              </button>
            )}
            {CAN_FULLSCREEN && <button className="player-round" aria-label="Full screen" onClick={fullscreen}>⛶</button>}
          </div>
        </div>
      )}

      {waiting && !loading && <span className="spinner big player-buffering" />}
      {(view.held || note) && <div className="player-note-over glass">{view.held ?? note}</div>}

      {upNext != null && play?.next && (
        <div className="up-next glass">
          {play.next.thumbnail && <img src={play.next.thumbnail} alt="" onError={e => { e.currentTarget.style.display = 'none' }} />}
          <div>
            <div className="eyebrow">Up next · {play.next.episode}</div>
            <b>{play.next.name}</b>
            <div className="up-next-buttons">
              <button className="btn primary" onClick={() => goNext(true)}>Play now{paused ? '' : ` (${upNext})`}</button>
              <button className="btn" onClick={() => { setUpNext(null); setUpNextDismissed(true) }}>Keep watching</button>
            </div>
          </div>
        </div>
      )}

      {onTv && play && (
        <PlayOnTv what={api.titleToPlay(play.type, play.id.split(':')[0], play.type === 'series' ? play.id : undefined)}
          name={[play.name, play.episode].filter(Boolean).join('  ·  ')} onClose={() => setOnTv(false)} />
      )}

      {panel && play && (
        <div className="player-panel-scrim" onClick={() => setPanel(null)}>
          <aside className="player-panel glass" onClick={e => e.stopPropagation()}>
            <button className="player-panel-close" onClick={() => setPanel(null)} aria-label="Close"><Icon name="act_close" size={18} /></button>
            <div className="player-panel-body">
              {panel === 'audio' ? (
                <AudioPanel session={s} close={() => setPanel(null)} switchTrack={switchTrack} />
              ) : panel === 'quality' ? (
                <QualityPanel session={s} close={() => setPanel(null)} />
              ) : panel === 'subtitles' ? (
                <SubtitlePanel subs={s.subtitleList()} chosen={subtitle} onPick={x => {
                  setSubtitle(x)
                  s.pickSubtitles(x ? x.lang : 'off')
                  setPanel(null)
                  if (x) s.note(`Subtitles: ${x.language}`)
                }} />
              ) : panel === 'picture' ? (
                <PicturePanel now={picture} onPick={f => { setPicture(f); setPanel(null) }} />
              ) : (
                <EpisodesPanel play={play} onPick={card => {
                  setPanel(null)
                  if (card.id === play.id) return
                  save()
                  leaving.current = true
                  const binge = s.stream()?.bingeGroup
                  navigate(`/watch/series/${card.id}${binge ? `?binge=${encodeURIComponent(binge)}` : ''}`,
                    { replace: true, state: { art: card.thumbnail ?? fallback ?? art, fallback, carry: s.carry() } })
                }} />
              )}
            </div>
          </aside>
        </div>
      )}
    </div>
  )
}


// ---------- Pieces ----------

function Chip({ icon, label, on, onClick }: { icon: IconName; label: string; on?: boolean; onClick: () => void }) {
  return (
    <button className={`player-chip${on ? ' on' : ''}`} aria-label={label} onClick={onClick}>
      <Icon name={icon} size={17} /> <span className="chip-label">{label}</span>
    </button>
  )
}

/** "Couldn't play this right now." with Keep trying or Back; or "Only other episodes were found. Play one anyway?" */
function ChoiceCard({ card, onPlay, onBack }: { card: 'keepTrying' | 'otherEpisodes'; onPlay: () => void; onBack: () => void }) {
  const go = useRef<HTMLButtonElement>(null)
  useEffect(() => { go.current?.focus() }, [card])
  return (
    <>
      <p className="player-note">{card === 'keepTrying' ? COULDNT_PLAY_NOW : OTHER_EPISODES}</p>
      <div className="player-other">
        <button ref={go} className="btn primary" onClick={onPlay}><Icon name="pl_play" size={16} /> {card === 'keepTrying' ? 'Keep trying' : 'Play'}</button>
        <button className="btn" onClick={onBack}>Back</button>
      </div>
    </>
  )
}

/** The release line under the title: what it is ("1080p · WEB-DL"), never where it comes from. */
function releaseLine(st: { resolution?: string; hdr?: string[]; source?: string | null; label?: string; plugin?: boolean; youtube?: string }) {
  if (st.youtube) return 'YouTube'
  if (st.plugin) return 'Auto quality'
  return [st.resolution, ...(st.hdr ?? []), st.source].filter(Boolean).join('  ·  ') || ''
}

/** Audio: one list of languages, as Netflix's. This file's switch in it (the smart way); one only another
 * version has switches to that version. Which file it is never shows. */
function AudioPanel({ session, close, switchTrack }: { session: Session; close: () => void; switchTrack: (track: number) => boolean }) {
  const [, redraw] = useState(0)
  // (More sources may bring more languages: the list fills in when they come.)
  useEffect(() => { const t = setInterval(() => redraw(n => n + 1), 1000); return () => clearInterval(t) }, [])
  const { here, elsewhere } = session.audioChoices()
  return (
    <>
      <h3>Audio</h3>
      {!here.length && !elsewhere.length && <div className="panel-item dim"><span>Only one audio track</span></div>}
      {here.map(h => (
        <button key={`h${h.track}`} className={`panel-item${h.on ? ' on' : ''}`} onClick={() => {
          close()
          session.pickTrack(h.code, h.on, h.track, () => switchTrack(h.track))
        }}>
          <span>{h.code ? languageName(h.code) : `Audio ${h.track + 1}`}</span>
        </button>
      ))}
      {elsewhere.map(code => (
        <button key={code} className="panel-item" onClick={() => { close(); session.findVersion(code) }}>
          <span>{languageName(code)}</span>
        </button>
      ))}
    </>
  )
}

/** Quality: Auto, each quality there's a file of in the language playing, and "Try another version". */
function QualityPanel({ session, close }: { session: Session; close: () => void }) {
  const { auto, qualities, another } = session.qualityChoices()
  const want = session.qualityWant
  return (
    <>
      <h3>Quality</h3>
      <button className={`panel-item${want == null ? ' on' : ''}`} onClick={() => { close(); session.pickAuto() }}>
        <span>Auto</span>{want == null && auto && <small>{auto}</small>}
      </button>
      {qualities.map(q => (
        <button key={q} className={`panel-item${want === q ? ' on' : ''}`} onClick={() => { close(); session.pickQuality(q) }}>
          <span>{QUALITY_NAMES[q] ?? q}</span>
        </button>
      ))}
      {another && (
        <button className="panel-item" onClick={() => { close(); session.tryAnother() }}><span>{TRY_ANOTHER}</span></button>
      )}
    </>
  )
}

function SubtitlePanel({ subs, chosen, onPick }: { subs: Subtitle[]; chosen: Subtitle | null; onPick: (s: Subtitle | null) => void }) {
  // Grouped by language; the best match for this release first within each (server order).
  const groups = subs.reduce<Record<string, Subtitle[]>>((g, s) => ((g[s.language] ??= []).push(s), g), {})
  // (By what it is: renewed links change a subtitle's address.)
  return (
    <>
      <h3>Subtitles</h3>
      <button className={`panel-item${!chosen ? ' on' : ''}`} onClick={() => onPick(null)}><span>Off</span></button>
      {Object.entries(groups).map(([language, list]) => (
        <details key={language} open={list.some(s => same(chosen, s))}>
          <summary className="panel-group">{language} <span>{list.length}</span></summary>
          {list.slice(0, 12).map(s => (
            <button key={s.url} className={`panel-item${same(chosen, s) ? ' on' : ''}`} onClick={() => onPick(s)}>
              <span>{releaseName(s.release) || language}</span>
            </button>
          ))}
        </details>
      ))}
    </>
  )
}

function PicturePanel({ now, onPick }: { now: Fit; onPick: (f: Fit) => void }) {
  const ways: [Fit, string, string][] = [
    ['contain', 'Fit', 'The whole picture, black bars if needed'],
    ['cover', 'Fill screen', 'No black bars, edges cropped'],
    ['fill', 'Stretch', 'Fill the screen, picture stretched'],
  ]
  return (
    <>
      <h3>Picture</h3>
      {ways.map(([f, label, detail]) => (
        <button key={f} className={`panel-item${now === f ? ' on' : ''}`} onClick={() => onPick(f)}>
          <span>{label}</span><small>{detail}</small>
        </button>
      ))}
    </>
  )
}

/** The episodes of this season: watched ones ticked, this one marked. */
function EpisodesPanel({ play, onPick }: { play: Play; onPick: (c: Card) => void }) {
  const [imdb, season] = play.id.split(':')
  const [episodes, setEpisodes] = useState<Card[] | null | 'failed'>(null)
  useEffect(() => {
    api.titlePage('series', imdb).then(p => setEpisodes(p.sections.find(x => x.id === `s${season}`)?.items ?? 'failed'), () => setEpisodes('failed'))
  }, [imdb, season])
  return (
    <>
      <h3>Season {season}</h3>
      {episodes == null ? <div className="panel-item dim"><span className="breathing">Loading episodes…</span></div>
        : episodes === 'failed' || !episodes.length ? <div className="panel-item dim"><span>Couldn't load the episodes</span></div>
          : episodes.map(e => {
            const here = e.id === play.id
            const state = here ? 'Playing now' : e.upcoming ? (e.aired ? `Not out yet · ${e.aired}` : 'Not out yet')
              : e.watched ? '✓ Watched' : e.progress != null ? `${Math.floor(e.progress * 100)}% watched` : e.aired ?? ''
            return (
              <button key={e.id} className={`panel-item${here ? ' on' : ''}${e.upcoming ? ' dim' : ''}`} disabled={!!e.upcoming && !here}
                onClick={() => onPick(e)}>
                <span>{[e.episode?.split(' ').pop(), e.name].filter(Boolean).join('  ·  ')}</span>
                {state && <small>{state}</small>}
              </button>
            )
          })}
    </>
  )
}

function splitEpisode(play?: Play): [string, string] {
  if (!play) return ['', '']
  if (play.type === 'movie') return ['Film', play.name]
  const [num, name] = (play.episode ?? '').split('·').map(x => x.trim())
  return [`${play.name}  ·  ${num ?? ''}`, name || num || play.name]
}

/** A round arrow with 10 in it: back (anticlockwise) or on. */
function Skip({ back }: { back?: boolean }) {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"
      style={back ? undefined : { transform: 'scaleX(-1)' }} aria-hidden="true">
      <path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3" />
      <path d="M6.2 3.2v3.6h3.6" />
      <text x="12" y="15.6" textAnchor="middle" fill="currentColor" stroke="none" fontSize="8.5" fontWeight="700"
        style={back ? undefined : { transform: 'scaleX(-1)', transformOrigin: '12px 12px' }}>10</text>
    </svg>
  )
}

function Timeline({ time, length, onSeek, onActive }: { time: number; length: number; onSeek: (t: number) => void; onActive: () => void }) {
  const pct = length ? (time / length) * 100 : 0
  return (
    <div className="timeline">
      <input
        type="range" min={0} max={length || 0} step={1} value={time} aria-label="Position"
        style={{ '--pct': `${pct}%` } as React.CSSProperties}
        // (Dragged by a finger, nothing else keeps the controls up meanwhile.)
        onPointerDown={onActive}
        onChange={e => { onActive(); onSeek(Number(e.target.value)) }}
      />
      <div className="timeline-times">
        <span className="timeline-time">{clock(time)}</span>
        <span className="timeline-time">−{clock(Math.max(0, length - time))}</span>
      </div>
    </div>
  )
}

function clock(sec: number) {
  const t = Math.floor(sec || 0)
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), x = t % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`
}

/** "The.Office.US.S05E13.720p.WEB-DL.en.srt" as "The Office US S05E13 720p WEB-DL". */
function releaseName(raw: string) {
  return (raw || '').replace(/(\.[a-z]{2,3})?\.(srt|vtt|ass|sub)$/i, '').replace(/[._]+/g, ' ').trim()
}

/** SRT to WebVTT: a header, and dots instead of commas in the times. */
function srtToVtt(srt: string) {
  return 'WEBVTT\n\n' + srt.replace(/\r/g, '').replace(/(\d\d:\d\d:\d\d),(\d\d\d)/g, '$1.$2')
}

