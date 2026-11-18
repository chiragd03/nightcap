import { useEffect, useMemo, useRef, useState } from 'react'
import { languageName, trackLanguages, twoLetter } from '../../../src/player/languages'
import { Progress, SAVE_EVERY_MS, SwitchMark, nearEnd, sameSubtitle, subtitleText, watchdog, type ProgressPart } from '../../../src/player/playback'
import {
  BACK_NOTE_MS, COULDNT_PLAY, COULDNT_PLAY_NOW, OTHER_EPISODES, QUALITY_NAMES, SPOKEN, TRY_ANOTHER, Session, type Carry, type Tracks, type View,
} from '../../../src/player/session'
import * as api from '../api'
import { focus as focusRaw } from '../focus'
import type { IconName } from '../icons'
import { useKeys, useNav, usePlayerScreen } from '../nav'
import * as pages from '../pages'
import type { Card } from '../pages'
import { holdAwake, holdSeeThrough, isAsking, setPlaying } from '../playing'
import Icon from '../ui/Icon'
import { later } from '../ui/Notice'
import { createEngine, LANG_NAMES, type Engine, type Events, type Fit, type Track } from './engine'
import * as prefs from './prefs'
import { clock, type Stream, type Subtitle } from './sources'
import * as subs from './subs'
import { tvHost } from './tvHost'
import './Player.css'

// The catalogue player, as the Android TV's: a calm loading screen
// (the title's picture, its name and one line), controls over the bottom (the gold play button on the
// timeline; Audio, Subtitles, Quality, Picture, Episodes and Next episode), panels above their chips, Up
// next, and the one-time questions. Which file plays, and everything about trying, waiting and giving
// up, is the shared session's (src/player/session.ts); this draws
// it and plays what it asks for on the TV's own player (engine.ts).

export type Source = { origin: string; row?: string; slot?: number; requestId?: string; modelVersion?: string }

const VIDEO_ID = /^tt\d+(:\d+:\d+)?$/
const SEEK_MS = 10_000
const SCRUB_SETTLE_MS = 550
/** A key pressed again this soon in the same direction counts as held (a TV that doesn't set e.repeat). */
const HELD_GAP_MS = 150
const HIDE_AFTER_MS = 4_000
const UP_NEXT_AT_MS = 25_000
const UP_NEXT_COUNTDOWN = 10
const EARLY_EXIT_AFTER_MS = 5 * 60_000
const EARLY_EXIT_BEFORE = 0.7
const EXIT_CARD_MS = 6_000
const RATE_CARD_MS = 10_000
const RATE_AFTER_EPISODES = 3
/** After a rating at the very end: the note saying it ("Love it") is seen before the player closes. */
const ANSWER_SEEN_MS = 1_200
/** Leaving from this far through (the credits, most likely), the rating is asked first. */
const RATE_ON_LEAVING_FROM = 0.9
/** Mid-film, waiting for the file: the spinner after this long. */
const SPINNER_AFTER_MS = 700
/** The file's tracks are listed one by one: read once they've settled (as the Android TV waits). */
const TRACKS_SETTLE_MS = 150
/** Focus moves the player makes by itself: never while Play on TV asks over it (its question keeps it). */
const focusEl = (el: HTMLElement | null | undefined) => { if (!isAsking()) focusRaw(el) }
/** Subtitles picked once the file's own are listed, or after this long anyway (big files take a while). */
const SUBS_AFTER_MS = 600
const SUBS_ANYWAY_MS = 3_000
/** A YouTube length too short to be the film is held as an ad's at most this long. */
const YT_AD_MOST_MS = 90_000
const OFF = 'off'

type Panel = 'audio' | 'subtitles' | 'quality' | 'picture' | 'episodes'
type Handlers = {
  playing(): void; started(): void; paused(): void; waiting(): void; time(ms: number): void; length(ms: number): void
  ended(): void; error(why: string, o?: { retry?: boolean }): void; tracks(): void; leave(): void; pickSubs(force: boolean): void
}
type Row = { key: string; label: string; detail?: string; chosen?: boolean; header?: boolean; run?: () => void
  /** The Timing row: Left/Right move the subtitles. */
  adjust?: boolean
  /** Something under way ("Loading episodes…"): it breathes. */
  waiting?: boolean
  /** An episode's still (96 x 54 dp), and its progress bar (0-1). */
  still?: string | null; progress?: number }

export default function Player({ type, id, name, episode, art, binge = null, source = { origin: 'direct' }, carry = {} }: {
  type: 'movie' | 'series'; id: string; name: string; episode?: string; art?: string; binge?: string | null; source?: Source
  /** What the episode before handed on: the audio pick, quality, subtitles (Session.carry()). */
  carry?: Carry
}) {
  const nav = useNav()
  // (A note left for later waits for the screen after it.)
  usePlayerScreen()
  const box = useRef<HTMLDivElement>(null)
  const parts = id.split(':')
  const isEpisode = type === 'series' && parts.length === 3

  // ---------- The session ----------

  const fresh = () => new Session(type, id, binge, carry, prefs.subtitles(), tvHost)
  const session = useRef<Session>(null as unknown as Session)
  if (!session.current) session.current = fresh()
  const s = session.current
  const [view, setView] = useState<View>(s.view)
  const play = view.play

  // ---------- The engine ----------

  const engine = useRef<Engine | null>(null)
  const [engineOn, setEngineOn] = useState(false)
  /** The session's attempt the engine was last given (-1: stopped): its events count only for that one. */
  const attempt = useRef(-1)
  /** Handing over to another screen: the session closed and the engine stopped. */
  const closed = useRef(false)
  /** The last save is made (finished, or handed over): nothing saves after it. */
  const saidBye = useRef(false)

  const [paused, setPaused] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const [spinner, setSpinner] = useState(false)
  const [time, setTime] = useState(0)
  const [length, setLength] = useState(0)
  const lengthNow = useRef(0)
  const [scrubTo, setScrubTo] = useState<number | null>(null)
  const [controls, setControlsState] = useState(false)
  const [panel, setPanel] = useState<{ which: Panel; lang?: string } | null>(null)
  const [cue, setCue] = useState<string | null>(null)
  const [online, setOnline] = useState<{ sub: Subtitle; cues: subs.Cue[] } | null>(null)
  const [delay, setDelay] = useState(0)
  const [fit, setFitState] = useState<Fit>('fit')
  const [upNext, setUpNext] = useState<number | null>(null)
  const [rating, setRating] = useState(false)
  const [rateClosing, setRateClosing] = useState(false)
  const [earlyExit, setEarlyExit] = useState(false)
  const [episodes, setEpisodes] = useState<Card[] | null | 'failed'>(null)
  const [note, setNote] = useState<{ text: string; n: number; out: boolean } | null>(null)
  const [, redraw] = useState(0)

  // What timers and the engine's events read: the latest of each.
  const now = useRef({ view, panel, controls, paused, upNext, rating, rateClosing, earlyExit })
  now.current = { view, panel, controls, paused, upNext, rating, rateClosing, earlyExit }

  /** The engine's events and the timers' work, as of the latest render. */
  const on = useRef<Handlers>(null as unknown as Handlers)
  const progress = useRef(new Progress()).current
  const switchMark = useRef(new SwitchMark()).current
  const scrubTarget = useRef<number | null>(null)
  const timers = useRef({
    hide: 0 as unknown as ReturnType<typeof setTimeout>, scrub: 0 as unknown as ReturnType<typeof setTimeout>,
    tracks: 0 as unknown as ReturnType<typeof setTimeout>, subs: [] as ReturnType<typeof setTimeout>[],
    rating: 0 as unknown as ReturnType<typeof setTimeout>, exit: 0 as unknown as ReturnType<typeof setTimeout>,
  }).current
  /** Per file: whether it was opened in the wanted track, put right, and its subtitles picked. */
  const perFile = useRef({ attempt: -1, opened: false, corrected: false, subsPicked: false })
  const upNextDismissed = useRef(false)
  const ratingAsked = useRef(false)
  const closeAfterRating = useRef(false)
  const ended = useRef(false)
  const repeats = useRef({ n: 0, at: 0, dir: 0 })
  const subsLoad = useRef(0)
  /** YouTube's length has been the video's (not an ad's), and a start waiting for it. Per file. */
  const ytReal = useRef(false)
  const ytStartWaits = useRef(false)
  const ytHold = useRef<ReturnType<typeof setTimeout> | 0>(0)

  // ---------- Leaving ----------

  /** Everything stops at once: a replaced or popped screen stays up a moment while the next opens. */
  const stop = () => {
    if (closed.current) return
    closed.current = true
    saidBye.current = true
    session.current.close()
    attempt.current = -1
    engine.current?.stop()
    clearTimeout(timers.hide)
    clearTimeout(timers.scrub)
    clearTimeout(timers.tracks)
    clearTimeout(ytHold.current)
    timers.subs.forEach(clearTimeout)
    clearTimeout(timers.rating)
    clearTimeout(timers.exit)
    subsLoad.current++
  }

  /** Closes the player the plain way: where it got to saved (once anything played), no question asked. */
  const leave = () => {
    if (closed.current) return
    if (!saidBye.current) save(false, true)
    stop()
    nav.pop()
  }

  // ---------- Saving ----------

  /** The audio playing, as three letters ("hin"): its tag, else the language heard. */
  const audioLanguage = () => {
    const e = engine.current
    const t = e?.audioTracks().find(x => x.id === e.currentAudio())
    if (t?.lang && t.lang.length === 3) return t.lang.toLowerCase()
    const heard = session.current.heardCode()
    const named = heard ? SPOKEN[heard] : undefined
    return named ? prefs.LANGS.find(l => l[1] === named)?.[0] : undefined
  }

  /** What's saved, as the Android TV's: where, how long, real time played, the picks, the audio language,
   * and where the play came from (its request kept through Up next). */
  const body = (part: ProgressPart) => {
    const lang = audioLanguage()
    return {
      type, id, ...part, origin: source.origin,
      ...(source.row ? { row: source.row } : {}), ...(source.slot != null ? { slot: source.slot } : {}),
      ...(source.requestId ? { requestId: source.requestId } : {}), ...(source.modelVersion ? { modelVersion: source.modelVersion } : {}),
      ...(lang ? { audioLanguage: lang } : {}),
    }
  }

  /** Where it's up to (mid-switch or reconnecting: where it had got to). */
  const position = () => {
    const e = engine.current
    return playingNow() && e && !inAd() ? e.time() : session.current.resumeFrom()
  }
  /** YouTube showing an ad (its length now isn't the one taken as the film's). */
  const inAd = () => !!session.current.view.open?.youtube && (!ytReal.current || Math.abs((engine.current?.length() ?? 0) - lengthNow.current) > 2000)
  /** A file is open and has started: not mid-reconnect, a renewal, a wait or a card (the engine stopped
   * while the session still counts as started). */
  const playingNow = () => attempt.current >= 0 && session.current.isStarted()
  // (YouTube's own length may be an ad's: only the one the session took. While nothing plays, the last
  // length taken: a file opening, maybe an error clip, never measures where it got to.)
  const duration = () => (session.current.view.open?.youtube || !playingNow() ? lengthNow.current : engine.current?.length() || lengthNow.current)

  /** Saves where it got to ([keepalive]: as the page goes away). */
  function save(finished = false, keepalive = false) {
    const ses = session.current
    const part = progress.next(ses, position(), duration(), finished)
    if (!part) return
    api.call('/launcher/progress', { body: body(part), keepalive }).then(
      () => { api.markChanged(); progress.answered(ses, part, true) },
      () => progress.answered(ses, part, false))
  }

  /** Leaving after the question ([reason]: its answer, or none): the exit carries the save and the picks. */
  const exitWith = (reason?: 'later' | 'not_for_me') => {
    if (closed.current) return
    const ses = session.current
    const pos = position(), len = duration()
    // (Nothing new to save: the exit still carries the place and the picks, never a place at or past
    // the length, an error clip's, say.)
    const part = progress.next(ses, pos, len) ?? { position: len > 0 && pos >= len ? 0 : Math.round(pos), duration: Math.round(len), played: 0, ...ses.picksToSend() }
    api.call('/launcher/exit', { body: { ...body(part), ...(reason ? { reason } : {}) }, keepalive: true }).then(
      () => { api.markChanged(); progress.answered(ses, part, true) },
      () => progress.answered(ses, part, false))
    stop()
    nav.pop()
  }

  // ---------- The next episode ----------

  /** Opens the next episode in the same release; this one saved as finished unless [finished] is false
   * (skipped mid-way: it keeps its place). */
  function playNext(finished = true) {
    const p = now.current.view.play
    if (!p?.next || closed.current) return
    save(finished)
    const ses = session.current
    const handed = ses.carry()
    const group = ses.stream()?.bingeGroup ?? null
    stop()
    nav.replace(<Player type="series" id={p.next.id} name={name} episode={`${p.next.episode}  ·  ${p.next.name}`} art={art}
      binge={group} source={{ ...source, origin: 'up_next', row: undefined, slot: undefined }} carry={handed} />)
  }

  function openEpisode(c: Card) {
    if (closed.current) return
    save()
    const ses = session.current
    const handed = ses.carry()
    const group = ses.stream()?.bingeGroup ?? null
    stop()
    nav.replace(<Player type="series" id={c.id} name={name} episode={[c.episode, c.name].filter(Boolean).join('  ·  ')} art={art}
      binge={group} source={{ ...source, origin: 'direct', row: undefined, slot: undefined }} carry={handed} />)
  }

  // ---------- Mounting ----------

  useEffect(() => {
    if (!VIDEO_ID.test(id) || (type !== 'movie' && type !== 'series')) { nav.pop(); return }
    // (React may run this twice in development, closing the first: a closed one is made again.)
    let ses = session.current
    if (ses.isClosed()) { ses = fresh(); session.current = ses }
    closed.current = false
    saidBye.current = false
    ses.onChange(setView)
    void ses.load()
    let gone = false
    const events: Events = {
      playing: () => on.current.playing(),
      started: () => on.current.started(),
      paused: () => on.current.paused(),
      waiting: () => on.current.waiting(),
      time: ms => on.current.time(ms),
      length: ms => on.current.length(ms),
      buffering: () => {},
      ended: () => on.current.ended(),
      error: (why, o) => on.current.error(why, o),
      tracks: () => { clearTimeout(timers.tracks); timers.tracks = setTimeout(() => on.current.tracks(), TRACKS_SETTLE_MS) },
      cue: text => { if (attempt.current >= 0) setCue(text) },
    }
    createEngine(box.current!, events).then(e => {
      if (gone) return e.destroy()
      engine.current = e
      setEngineOn(true)
    }, () => {
      // (The player's own code didn't load, a network blip: no file is to blame, none is reported.)
      if (gone) return
      later(COULDNT_PLAY)
      on.current.leave()
    })
    // The page see-through while playing (Samsung draws the video on a plane under it).
    const letGo = [holdSeeThrough(), holdAwake()]
    // What's playing, for Play on TV.
    const unregister = setPlaying({
      pause: () => {
        const e = engine.current
        if (!e || e.isPaused() || !session.current.isStarted()) return false
        e.pause()
        return true
      },
      resume: () => engine.current?.play(),
      close: () => on.current.leave(),
    })
    return () => {
      gone = true
      // (Popped or replaced without going through here, or the app reset: saved, and everything stops.)
      if (!saidBye.current) save(false, true)
      stop()
      for (const f of letGo) f()
      unregister()
      engine.current?.destroy()
      engine.current = null
      setEngineOn(false)
    }
  }, [])

  // The file the session asks for: opened once per attempt; none, stopped (nothing plays behind a card).
  const openAttempt = view.open?.attempt ?? -1
  useEffect(() => {
    const e = engine.current
    if (!engineOn || !e || closed.current) return
    const o = session.current.view.open
    if (!o) { attempt.current = -1; e.stop(); return }
    if (o.attempt === attempt.current) return
    attempt.current = o.attempt
    ytReal.current = false
    ytStartWaits.current = false
    clearTimeout(ytHold.current)
    ytHold.current = 0
    // (A skip still settling belongs to the last file.)
    clearTimeout(timers.scrub)
    scrubTarget.current = null
    setScrubTo(null)
    perFile.current = { attempt: o.attempt, opened: false, corrected: false, subsPicked: false }
    clearTimeout(timers.tracks)
    timers.subs.forEach(clearTimeout)
    switchMark.clear()
    setWaiting(false)
    setCue(null)
    const st = session.current.stream(o.index)
    e.open(o.url, o.at, hlsJs(st), o.youtube)
    // (Its time to start counts from now: the engine is really opening it.)
    session.current.begin(o.attempt)
  }, [engineOn, openAttempt])

  // The play is over: said on the next screen, and the player closes.
  useEffect(() => {
    if (!view.ended) return
    later(view.ended)
    leave()
  }, [view.ended])

  // Back to the loading screen (a file opening): the controls and any panel go at once.
  useEffect(() => {
    if (!view.loading) return
    clearTimeout(timers.hide)
    setPanel(null)
    setControlsState(false)
    setWaiting(false)
  }, [view.loading])

  // ---------- The engine's events ----------

  on.current = {
    playing() {
      if (attempt.current < 0) return
      setPaused(false)
      setWaiting(false)
      scheduleHide()
    },
    started() {
      const att = attempt.current, e = engine.current
      if (att < 0 || !e) return
      // (YouTube: an ad plays first, with the ad's length. Started once the video's own length shows.)
      if (session.current.view.open?.youtube && !ytReal.current) { ytStartWaits.current = true; return }
      session.current.startedPlaying(att, e.time())
      // Subtitles once the file's own are listed (big files take a while).
      timers.subs.forEach(clearTimeout)
      timers.subs = [setTimeout(() => on.current.pickSubs(false), SUBS_AFTER_MS), setTimeout(() => on.current.pickSubs(true), SUBS_ANYWAY_MS)]
    },
    paused() {
      if (attempt.current < 0 || !session.current.isStarted()) return
      setPaused(true)
      setWaiting(false)
      if (!saidBye.current) save()
      setControls(true)
    },
    waiting() {
      if (attempt.current >= 0 && session.current.isStarted()) setWaiting(true)
    },
    time(ms: number) {
      const att = attempt.current, e = engine.current
      if (att < 0 || !e) return
      const ses = session.current
      // (YouTube in an ad, its length not the film's: the ad's clock isn't where the film is.)
      if (inAd()) return
      progress.tick(ms / 1000, e.isPaused())
      dog.current?.arriving()
      // (Switching tracks, it may play on from where it was for a moment: where it got to stays.)
      if (switchMark.time(ses, ms / 1000)) ses.time(att, ms)
      if (scrubTarget.current == null) setTime(ms)
      // (Only once it plays: an ad's or an opening file's time isn't the film's end.)
      if (playingNow()) checkUpNext(ms)
    },
    length(ms: number) {
      if (attempt.current < 0) return
      const att = attempt.current, ses = session.current
      if (ses.view.open?.youtube) {
        // (An ad's length isn't the video's: held until it's long enough to be it. Meanwhile the ad isn't
        // the file failing to start: its 30 s wait for the start is held too.)
        const runtime = ses.view.play?.runtimeMs
        if (ms < (runtime ? runtime * 0.4 : 90_000)) {
          if (ytReal.current) return
          ses.blocked(att)
          // (Held as an ad only as long as an ad runs: still this short after that, it's what the video
          // is, a trailer or a part, and the session judges it.)
          if (!ytHold.current) {
            ytHold.current = setTimeout(() => {
              ytHold.current = 0
              if (attempt.current !== att || ytReal.current) return
              ses.unblocked(att)
              ses.length(att, engine.current?.length() || ms)
            }, YT_AD_MOST_MS)
          }
          return
        }
        clearTimeout(ytHold.current)
        ytHold.current = 0
        if (!ytReal.current) ses.unblocked(att)
        ytReal.current = true
        if (ytStartWaits.current) { ytStartWaits.current = false; Promise.resolve().then(() => on.current.started()) }
      }
      ses.length(att, ms)
      // (Kept only once the session took it: an error clip's length, which fails the file, isn't the film's.)
      if (ses.attemptNow() !== att) return
      setLength(ms)
      lengthNow.current = ms
    },
    ended() {
      const att = attempt.current
      if (att < 0) return
      const ses = session.current
      // (Where it got to before the end, against its length: a dropped stream "ends" early.)
      if (!ses.ended(att, ses.resumeFrom(), duration())) return
      if (now.current.view.play?.next && !upNextDismissed.current) return playNext(true)
      save(true)
      saidBye.current = true
      // The rating card is up, unanswered: it stays its full time on the last picture, and the player
      // closes once it's answered or put away (hideRating).
      if (now.current.rating && !now.current.rateClosing) {
        closeAfterRating.current = true
        ended.current = true
        clearTimeout(timers.rating)
        timers.rating = setTimeout(() => hideRating(), RATE_CARD_MS)
        return
      }
      leave()
    },
    error(why: string, o?: { retry?: boolean }) {
      if (attempt.current < 0) return
      // (YouTube's "not available" plays on no retry: the defaults otherwise, as the Android TV's.)
      session.current.error(attempt.current, why, o?.retry === false ? { retry: false } : {})
    },
    tracks() { readTracks() },
    leave() { leave() },
    pickSubs(force: boolean) { pickSubs(force) },
  }

  // ---------- Audio: the file's own tracks ----------

  /** The engine's tracks as the session reads them: each one's language (its tag as two letters, else
   * its name, the server's rule), the one playing, their names. */
  function tracksNow(): (NonNullable<Tracks> & { list: Track[] }) | null {
    const e = engine.current
    const list = e?.audioTracks() ?? []
    if (!e || !list.length) return null
    const st = session.current.stream()
    const named = list.map(t => ({ language: twoLetter(t.lang), name: t.title || t.label }))
    // (Not by the server's header reading: the TV may list its tracks in another order. The tags and
    // the names decide.)
    const languages = trackLanguages(named, tvHost.headerIndexes ? st?.fileAudio : undefined)
    const playing = Math.max(0, list.findIndex(t => t.id === e.currentAudio()))
    return { languages, playing, names: list.map(t => [t.title || t.label, t.note].filter(Boolean).join(' ')), list }
  }

  const seekable = () => (engine.current?.length() ?? 0) > 0

  /** Switches to track [i] of the file, heard at once (what's buffered of the old one dropped by a seek
   * to the same moment). Whether it took. */
  function selectTrack(i: number, mark: boolean) {
    const e = engine.current
    const t = tracksNow()?.list[i]
    if (!e || !t || !e.selectAudio(t.id)) return false
    if (seekable()) {
      const at = e.time()
      if (mark) switchMark.set(at / 1000)
      e.seek(at)
    }
    return true
  }

  /** Audio picked in the panel: track [i] of this file, switched to from where it is. */
  function switchTrack(i: number) {
    const att = attempt.current
    if (!selectTrack(i, true)) return false
    const t = tracksNow()
    if (t) session.current.setTracks(att, { languages: t.languages, playing: i, names: t.names })
    return true
  }

  /** The file's tracks are listed: before it plays, it's opened in the wanted one (silently: there's no
   * open-time choice on the TV's player); then put right where a track's name says the wanted language
   * while another plays (the late correction); then the session told. */
  function readTracks() {
    const att = attempt.current, ses = session.current
    if (att < 0 || att !== ses.attemptNow()) return
    let t = tracksNow()
    if (!t) return
    const f = perFile.current
    if (!ses.isStarted() && !f.opened) {
      f.opened = true
      const want = ses.openTrack(t.languages, t.names)
      if (want != null && want !== t.playing && selectTrack(want, false)) t = tracksNow() ?? t
    }
    if (!f.corrected) {
      f.corrected = true
      const better = ses.lateCorrection(t)
      const code = better != null ? t.languages[better] : null
      if (better != null && code) {
        if (ses.isStarted()) ses.switchTo_(code, () => selectTrack(better, true))
        else selectTrack(better, false)
        t = tracksNow() ?? t
      }
    }
    ses.setTracks(att, { languages: t.languages, playing: t.playing, names: t.names })
    redraw(n => n + 1)
  }

  // ---------- Subtitles (as Android's) ----------

  /** Once per file, after it plays: the file's own track in the wanted language (not a forced one), else
   * online, else off. [force]: even if the file listed no tracks. */
  function pickSubs(force: boolean) {
    const e = engine.current, ses = session.current, att = attempt.current, f = perFile.current
    if (!e || att < 0 || f.attempt !== att || f.subsPicked || !ses.isStarted()) return
    // (A service whose files list no tracks: its files count for their first language only.)
    if (force && !e.audioTracks().length && !ses.stream()?.youtube && tvHost.tracksSwitchable(ses.stream())) ses.unreadable(att)
    if (!force && !e.audioTracks().length) return
    f.subsPicked = true
    const want = ses.subsWant()
    if (want === OFF) { e.selectText(null); setOnline(null); return }
    const list = ses.subtitleList()
    const lang = (list.find(x => x.lang === want)?.language ?? LANG_NAMES[want] ?? want).toLowerCase()
    const inside = e.textTracks().find(t => `${t.label} ${t.title ?? ''}`.toLowerCase().includes(lang) && !/forced/i.test(`${t.title ?? ''} ${t.note ?? ''}`))
    if (inside) { setOnline(null); e.selectText(inside.id); return }
    const there = list.find(x => x.lang === want)
    if (there) return loadOnline(there)
    e.selectText(null)
  }

  /** Online subtitles, fetched through the server's link (once more after a hiccup; renewed when expired)
   * and drawn here, so their timing can move. */
  function loadOnline(sub: Subtitle) {
    engine.current?.selectText(null)
    if (online && sameSubtitle(online.sub, sub)) return
    const n = ++subsLoad.current
    setOnline(null)
    subtitleText(session.current, sub, () => n !== subsLoad.current).then(text => {
      if (n !== subsLoad.current) return
      const cues = subs.parse(text)
      if (!cues.length) return Promise.reject(new Error('empty'))
      setOnline({ sub, cues })
    }).catch(() => { if (n === subsLoad.current) session.current.note("Couldn't load those subtitles", BACK_NOTE_MS) })
  }

  /** A subtitle track of the file picked: kept for this show in its language (else the usual one). */
  function rememberSubs(t: Track) {
    const text = `${t.title ?? ''} ${t.label}`.toLowerCase()
    const code = prefs.LANGS.find(l => text.includes(l[1].toLowerCase()) || t.lang?.toLowerCase() === l[0])?.[0]
      ?? [session.current.subsWant(), prefs.subtitles()].find(x => x !== OFF) ?? 'eng'
    session.current.pickSubtitles(code)
  }

  // ---------- Saving every 30 s; the app put away ----------

  useEffect(() => {
    if (!view.everStarted) return
    const t = setInterval(() => { if (!saidBye.current) save() }, SAVE_EVERY_MS)
    return () => clearInterval(t)
  }, [view.everStarted])

  useEffect(() => {
    // The TV put away or another app: saved, and the player closes.
    const onHide = () => { if (document.visibilityState === 'hidden') on.current.leave() }
    document.addEventListener('visibilitychange', onHide)
    return () => document.removeEventListener('visibilitychange', onHide)
  }, [])

  // ---------- Waiting mid-film: the spinner, and the watchdog ----------

  const switching = !!view.held && s.isSwitching()
  useEffect(() => {
    if (!waiting) { setSpinner(false); return }
    const t = setTimeout(() => setSpinner(true), SPINNER_AFTER_MS)
    return () => clearTimeout(t)
  }, [waiting])

  // Mid-film, waiting with nothing arriving for a while: the connection dropped, though the TV's player may
  // never say so. Logged only: how a TV's player reports waiting isn't known well enough to act on.
  const dog = useRef<{ arriving(): void } | null>(null)
  useEffect(() => {
    const e = engine.current
    if (!waiting || paused || !view.everStarted || openAttempt < 0 || !e) return
    const att = openAttempt
    const d = watchdog({
      arrived: () => engine.current?.buffered() ?? 0,
      switching: () => switchMark.active,
      fail: () => session.current.error(att, 'stopped arriving'),
      act: false,
    })
    dog.current = d
    return () => { d.stop(); dog.current = null }
  }, [waiting, paused, view.everStarted, openAttempt])

  // ---------- Notes ----------

  // A note in the corner for its time (150 ms in, then out over 400 ms); a held one stays.
  useEffect(() => {
    const n = view.note
    if (!n) return
    setNote({ text: n.text, n: n.n, out: false })
    const out = setTimeout(() => setNote(x => (x && x.n === n.n ? { ...x, out: true } : x)), 150 + n.ms)
    const gone = setTimeout(() => setNote(x => (x && x.n === n.n ? null : x)), 150 + n.ms + 400)
    return () => { clearTimeout(out); clearTimeout(gone) }
  }, [view.note?.n])

  // ---------- Up next and the rating, in the credits ----------

  function checkUpNext(t: number) {
    const len = duration()
    if (len <= 0) return
    const left = len - t
    const p = now.current.view.play
    if (left <= UP_NEXT_AT_MS && scrubTarget.current == null && !p?.next) maybeAskRating()
    // In the last few minutes, the next episode's sources are found ahead of time.
    nearEnd(session.current, p?.next?.id, left / 1000)
    if (!p?.next) return
    const inEnd = left <= UP_NEXT_AT_MS
    const shown = now.current.upNext != null
    if (inEnd && !shown && !upNextDismissed.current && scrubTarget.current == null && !now.current.panel) setUpNext(UP_NEXT_COUNTDOWN)
    else if (!inEnd && shown) hideUpNext()
    else if (!inEnd) upNextDismissed.current = false
  }

  function hideUpNext() {
    setUpNext(null)
    focusEl(timeline.current)
  }

  // Up next's countdown, only while it plays.
  useEffect(() => {
    if (upNext == null || paused || view.loading) return
    if (upNext <= 0) { playNext(); return }
    const t = setTimeout(() => setUpNext(n => (n == null ? n : n - 1)), 1000)
    return () => clearTimeout(t)
  }, [upNext, paused, view.loading])

  /** Whether the end has been reached: the episode counts as finished (Next episode pressed in the credits). */
  const inCredits = () => { const len = duration(); return len > 0 && len - (engine.current?.time() ?? 0) <= UP_NEXT_AT_MS }

  /** Whether this title's rating may still be asked: not rated or asked yet, and for a show, its latest
   * episode once you've seen a few. */
  function canAskRating() {
    const p = now.current.view.play
    return !!p && p.myRating == null && !ratingAsked.current && !p.asked?.includes('rating') && !now.current.rating &&
      !(type === 'series' && (!!p.next || (p.finishedEpisodes ?? 0) + 1 < RATE_AFTER_EPISODES))
  }
  function maybeAskRating() {
    // (Not over a panel: it's asked once that's closed, as the end draws nearer.)
    if (canAskRating() && !now.current.panel) askRating()
  }
  function askRating() {
    ratingAsked.current = true
    api.post('/launcher/prompt', { id: parts[0], kind: 'rating' }).catch(() => {})
    // (The card has the screen to itself: the controls go, and come back only after it.)
    setControls(false)
    setRateClosing(false)
    setRating(true)
    clearTimeout(timers.rating)
    timers.rating = setTimeout(() => hideRating(), RATE_CARD_MS)
  }
  /** Puts the rating card away. When the video has ended under it, or it was asked as you left, the
   * player then closes: at once, or, [answered], once the answer has been seen ("Love it"). */
  function hideRating(answered = false) {
    clearTimeout(timers.rating)
    if (!now.current.rating || now.current.rateClosing) return
    setRateClosing(true)
    setTimeout(() => {
      setRating(false)
      setRateClosing(false)
      if (closeAfterRating.current) setTimeout(() => on.current.leave(), answered ? ANSWER_SEEN_MS : 0)
      else focusEl(timeline.current)
    }, 220)
  }
  function rate(value: -1 | 1 | 2, label: string) {
    const p = now.current.view.play
    if (p) p.myRating = value
    api.post('/launcher/rating', { id: parts[0], value }).catch(() => {})
    session.current.note(label)
    hideRating(true)
  }

  // ---------- Leaving early ----------

  /** Back after a while but well before the end, the first time for this title. */
  function shouldAskOnLeaving() {
    const len = duration(), t = engine.current?.time() ?? 0
    return len > 0 && !now.current.view.play?.asked?.includes('early_exit') && t >= EARLY_EXIT_AFTER_MS && t < len * EARLY_EXIT_BEFORE
  }
  function askOnLeaving() {
    engine.current?.pause()
    setEarlyExit(true)
    clearTimeout(timers.exit)
    timers.exit = setTimeout(() => exitWith(), EXIT_CARD_MS)
  }
  /** Back near the end (in the credits, most likely): asked then, the picture paused, and the player
   * closes once it's answered or put away. */
  const shouldRateOnLeaving = () => { const len = duration(); return len > 0 && (engine.current?.time() ?? 0) >= len * RATE_ON_LEAVING_FROM && canAskRating() }
  function rateOnLeaving() {
    engine.current?.pause()
    closeAfterRating.current = true
    askRating()
  }

  // ---------- Controls ----------

  const timeline = useRef<HTMLDivElement>(null)
  const playButton = useRef<HTMLButtonElement>(null)
  const chips = useRef<HTMLDivElement>(null)
  const chip = (which: string) => chips.current?.querySelector<HTMLElement>(`[data-chip="${which}"]`)

  function scheduleHide() {
    clearTimeout(timers.hide)
    const e = engine.current
    if (e && !e.isPaused() && !now.current.panel) timers.hide = setTimeout(() => setControls(false), HIDE_AFTER_MS)
  }

  /** The controls shown or hidden: shown, focus on the timeline (unless a panel is open); never over the
   * loading screen. */
  function setControls(show: boolean) {
    clearTimeout(timers.hide)
    if (show && now.current.view.loading) return
    if (show === now.current.controls) return
    setControlsState(show)
    now.current.controls = show
    if (!show || !now.current.panel) focusTimeline()
  }
  /** Focus back on the timeline, unless a card (rating, leaving) is open: its choice keeps the focus. */
  function focusTimeline() {
    if (now.current.rating || now.current.earlyExit) return
    // (Play on TV asking over the film: its question keeps the focus.)
    setTimeout(() => { if (!isAsking()) focusEl(timeline.current) }, 0)
  }

  function togglePause() {
    const e = engine.current
    if (!e) return
    if (e.isPaused()) { e.play(); setPaused(false); scheduleHide() }
    else { e.pause(); setPaused(true); session.current.note('Paused') }
    setControls(true)
  }

  /** ⏯ toggles; ▶ only plays and ❚❚ only pauses (a remote with both). */
  function mediaKey(key: 'playpause' | 'play' | 'pause') {
    const stopped = engine.current?.isPaused()
    if (stopped == null) return
    if (key === 'playpause' || (key === 'play') === stopped) togglePause()
  }

  // Scrubbing: steps add up, faster the longer the key is held; the seek happens once the keys stop.
  function scrub(dir: 1 | -1, ev: KeyboardEvent) {
    const e = engine.current
    const len = duration()
    if (!e || len <= 0) return
    const r = repeats.current, at = Date.now()
    const held = ev.repeat || (r.dir === dir && at - r.at < HELD_GAP_MS)
    r.n = held ? r.n + 1 : 0
    r.at = at
    r.dir = dir
    const step = r.n > 24 ? 60_000 : r.n > 8 ? 30_000 : SEEK_MS
    const target = (scrubTarget.current ?? e.time()) + dir * step
    // Skipping forward past the end of an episode goes straight to the next one.
    if (dir > 0 && target >= len - 2_000 && now.current.view.play?.next) {
      clearTimeout(timers.scrub)
      scrubTarget.current = null
      setScrubTo(null)
      return playNext()
    }
    const to = Math.max(0, Math.min(len - 2_000, target))
    scrubTarget.current = to
    setScrubTo(to)
    setControls(true)
    clearTimeout(timers.scrub)
    timers.scrub = setTimeout(() => {
      scrubTarget.current = null
      setScrubTo(null)
      switchMark.clear()
      engine.current?.seek(to)
    }, SCRUB_SETTLE_MS)
  }

  // ---------- Panels ----------

  const lastChip = useRef<Panel>('audio')
  function openPanel(which: Panel, lang?: string) {
    lastChip.current = which
    setPanel({ which, lang })
    clearTimeout(timers.hide)
    if (which === 'episodes' && isEpisode) {
      setEpisodes(null)
      // Fresh: the ticks change as you watch.
      pages.get<pages.Page>(pages.pagePath('series', parts[0]), true).then(pg => {
        const items = pg.sections.find(x => x.id === `s${parts[1]}`)?.items ?? []
        setEpisodes(items.length ? items : 'failed')
      }, () => setEpisodes('failed'))
    }
  }
  /** Back to the chip the panel came from (or the timeline once the controls are hidden). */
  function closePanel() {
    setPanel(null)
    now.current.panel = null
    const which = lastChip.current
    if (now.current.controls) setTimeout(() => focusEl(chip(which) ?? timeline.current), 0)
    scheduleHide()
  }

  // (More sources may bring more languages: Audio fills in when they come.)
  useEffect(() => {
    if (panel?.which !== 'audio') return
    const t = setInterval(() => redraw(n => n + 1), 1000)
    return () => clearInterval(t)
  }, [panel?.which])

  function panelRows(which: Panel, lang?: string): Row[] {
    const e = engine.current, ses = session.current
    if (!e || !play) return []
    if (which === 'audio') {
      // One list of languages, as Netflix's: this file's switch in it; one only another version has
      // switches to that version (findVersion). Which file it is never shows.
      const { here, elsewhere } = ses.audioChoices()
      const rows: Row[] = []
      if (!here.length && !elsewhere.length) rows.push({ key: 'none', label: 'Only one audio track' })
      for (const h of here) rows.push({
        key: `h${h.track}`, label: (h.code && SPOKEN[h.code]) || `Audio ${h.track + 1}`, chosen: h.on,
        run: () => { closePanel(); ses.pickTrack(h.code, h.on, h.track, () => switchTrack(h.track), seekable()) },
      })
      for (const code of elsewhere) rows.push({ key: `e${code}`, label: languageName(code), run: () => { closePanel(); ses.findVersion(code) } })
      return rows
    }
    if (which === 'quality') {
      // Auto, each quality there's a file of in the language playing, and "Try another version".
      const { auto, qualities, another } = ses.qualityChoices()
      const want = ses.qualityWant
      const rows: Row[] = [{ key: 'auto', label: 'Auto', detail: want == null && auto ? auto : undefined, chosen: want == null, run: () => { closePanel(); ses.pickAuto() } }]
      for (const q of qualities) rows.push({ key: q, label: QUALITY_NAMES[q] ?? q, chosen: want === q, run: () => { closePanel(); ses.pickQuality(q) } })
      if (another) rows.push({ key: 'another', label: TRY_ANOTHER, run: () => { closePanel(); ses.tryAnother() } })
      return rows
    }
    if (which === 'subtitles') {
      const list = ses.subtitleList()
      const want = lang ?? [ses.subsWant()].find(x => x !== OFF) ?? 'eng'
      const own = e.textTracks(), nowOwn = e.currentText()
      const rows: Row[] = [
        { key: 'off', label: 'Off', chosen: !online && nowOwn == null, run: () => {
          e.selectText(null); subsLoad.current++; setOnline(null); ses.pickSubtitles(OFF); closePanel()
        } },
        { key: 'timing', label: 'Timing', detail: timing(delay), adjust: true },
      ]
      if (own.length) rows.push({ key: 'h-own', label: 'In this file', header: true })
      for (const t of own) rows.push({
        key: `own-${t.id}`, label: t.label, detail: t.note, chosen: !online && t.id === nowOwn,
        run: () => { subsLoad.current++; setOnline(null); e.selectText(t.id); rememberSubs(t); closePanel() },
      })
      const theirs = list.filter(x => x.lang === want)
      if (theirs.length) {
        rows.push({ key: 'h-online', label: `Online · ${theirs[0].language}`, header: true })
        for (const sub of theirs.slice(0, 12)) rows.push({
          key: sub.url, label: subs.cleanRelease(sub.release ?? '') || sub.language, detail: sub.language, chosen: !!online && sameSubtitle(online.sub, sub),
          run: () => { loadOnline(sub); ses.pickSubtitles(sub.lang); closePanel(); ses.note(`Subtitles: ${sub.language}`) },
        })
      }
      const others = list.map(x => x.lang).filter((c, i, all) => c !== want && all.indexOf(c) === i)
      if (others.length) rows.push({ key: 'h-other', label: 'Other languages', header: true })
      for (const c of others) {
        const n = list.filter(x => x.lang === c).length
        rows.push({ key: `lang-${c}`, label: list.find(x => x.lang === c)?.language ?? c, detail: `${n} subtitle${n === 1 ? '' : 's'}`, run: () => openPanel('subtitles', c) })
      }
      return rows
    }
    if (which === 'picture') {
      const pick = (f: Fit) => () => { e.setFit(f); setFitState(f); closePanel() }
      return [
        { key: 'fit', label: 'Fit', detail: 'The whole picture, black bars if needed', chosen: fit === 'fit', run: pick('fit') },
        { key: 'fill', label: 'Fill screen', detail: 'No black bars, edges cropped', chosen: fit === 'fill', run: pick('fill') },
        { key: 'stretch', label: 'Stretch', detail: 'Fill the screen, picture stretched', chosen: fit === 'stretch', run: pick('stretch') },
      ]
    }
    // Episodes: this season's, watched ones ticked, this one marked.
    if (episodes == null) return [{ key: 'loading', label: 'Loading episodes…', waiting: true }]
    if (episodes === 'failed') return [{ key: 'failed', label: "Couldn't load the episodes" }]
    return episodes.map(c => {
      const here = c.id === id
      const state = here ? 'Playing now' : c.upcoming ? (c.aired ? `Not out yet · ${c.aired}` : 'Not out yet')
        : c.watched ? '✓ Watched' : c.progress != null ? `${Math.floor(c.progress * 100)}% watched` : c.aired ?? ''
      return {
        // (As Android: the number after the season, "S1 E3" → "E3", and the episode's own still only.)
        key: c.id, label: [c.episode && c.episode.indexOf(' ') >= 0 ? c.episode.slice(c.episode.indexOf(' ') + 1) : c.episode, c.name].filter(Boolean).join('  ·  '), detail: state, chosen: here,
        still: c.thumbnail ?? null, progress: !here && c.progress != null ? c.progress : undefined,
        run: () => {
          if (here) return closePanel()
          if (c.upcoming) return ses.note('Not out yet')
          openEpisode(c)
        },
      }
    })
  }

  // ---------- The remote: the Android TV's order ----------

  useKeys((key, ev) => {
    const ses = session.current, e = engine.current
    const n = now.current
    // 1. Play on TV is asking over the video: its keys are its own.
    if (isAsking()) return
    // 2. "Couldn't play this right now." / "Play one anyway?": its own keys; Back leaves.
    if (n.view.card) {
      if (key === 'back') { leave(); return true }
      // (Shown while Play on TV asked: the focus is still behind it. Onto the card first.)
      if (!document.activeElement?.closest('.player-card')) { focusEl(document.querySelector<HTMLElement>('.player-card-choices > *')); return true }
      if (key === 'left' || key === 'right' || key === 'ok') return
      return true
    }
    // 3. The file being opened hasn't started (mid-film reconnects too): only Back, which goes back to
    // the version you were watching when one you picked is opening, else closes the plain way.
    if (!playingNow()) {
      if (key === 'back' && !ses.cancelSwitch()) leave()
      return true
    }
    // 4. Leaving early: any key restarts its 6 s; Back leaves, as answered.
    if (n.earlyExit) {
      clearTimeout(timers.exit)
      timers.exit = setTimeout(() => exitWith(), EXIT_CARD_MS)
      if (key === 'back') { exitWith(); return true }
      if (!document.activeElement?.closest('.player-card')) { focusEl(document.querySelector<HTMLElement>('.player-card-choices > *')); return true }
      if (key === 'left' || key === 'right' || key === 'ok') return
      return true
    }
    // 5. The rating card: Left/Right/OK use it (its 10 s again); Back puts it away; play and pause still
    // work, the card staying up; anything else does nothing, so a stray press doesn't throw it away.
    if (n.rating) {
      if (key === 'left' || key === 'right' || key === 'ok') {
        clearTimeout(timers.rating)
        timers.rating = setTimeout(() => hideRating(), RATE_CARD_MS)
        // (Nothing on the card focused: the press lands on I like it rather than picking or moving.)
        if (!document.activeElement?.closest('.rate-box')) { focusEl(document.querySelectorAll<HTMLElement>('.rate-choice')[1]); return true }
        return
      }
      if (key === 'back') { hideRating(); return true }
      if ((key === 'playpause' || key === 'play' || key === 'pause') && e) {
        if (key === 'play' || (key === 'playpause' && e.isPaused())) {
          // Asked as you left, and you play on: you're staying after all (not once it's ended).
          if (!ended.current) closeAfterRating.current = false
          e.play()
        } else e.pause()
      }
      return true
    }
    // 6. Up next: OK plays it; Back dismisses it; Left or Rewind dismiss it and go on; Right or Fast
    // forward skip on towards it, Up next staying; play and pause work, Up next staying (its Play
    // button is the one OK presses, whatever the controls show).
    if (n.upNext != null) {
      if (key === 'ok') { playNext(); return true }
      if (key === 'back') { upNextDismissed.current = true; hideUpNext(); return true }
      if (key === 'left' || key === 'rw') { upNextDismissed.current = true; hideUpNext() }
      else if (key === 'right' || key === 'ff') { scrub(1, ev); return true }
      else if (key === 'playpause' || key === 'play' || key === 'pause') { mediaKey(key); return true }
      else return true
    }
    // 7. The media keys.
    if (key === 'playpause' || key === 'play' || key === 'pause') { mediaKey(key); return true }
    if (key === 'ff') { scrub(1, ev); return true }
    if (key === 'rw') { scrub(-1, ev); return true }
    if (key === 'stop' || key === 'next' || key === 'prev') return true
    // 8. A panel: Back closes it; any other key is the panel's (Left/Right on Timing move the subtitles).
    if (n.panel) {
      clearTimeout(timers.hide)
      if (key === 'back') { closePanel(); return true }
      const adjust = !!(document.activeElement as HTMLElement | null)?.hasAttribute('data-adjust')
      if (adjust && (key === 'left' || key === 'right')) { setDelay(d => Math.round((d + (key === 'left' ? -0.1 : 0.1)) * 10) / 10); return true }
      if (key === 'left' || key === 'right') return true
      return
    }
    // 9. Controls hidden.
    if (!n.controls) {
      if (key === 'left') scrub(-1, ev)
      else if (key === 'right') scrub(1, ev)
      else if (key === 'ok') togglePause()
      else if (key === 'up') setControls(true)
      else if (key === 'down') { setControls(true); setTimeout(() => focusEl(chip('subtitles')), 0) }
      else if (key === 'back') {
        if (shouldAskOnLeaving()) askOnLeaving()
        else if (shouldRateOnLeaving()) rateOnLeaving()
        else leave()
      }
      return true
    }
    // 10. Controls shown: every key keeps them up a while longer.
    scheduleHide()
    if (key === 'back') { setControls(false); return true }
    const active = document.activeElement
    if (active === timeline.current) {
      if (key === 'left') { scrub(-1, ev); return true }
      if (key === 'right') { scrub(1, ev); return true }
      if (key === 'ok') { togglePause(); return true }
      if (key === 'up') return true
      if (key === 'down') { focusEl(chip('subtitles')); return true }
    } else if (active === playButton.current) {
      if (key === 'right') { focusEl(timeline.current); return true }
      if (key === 'down') { focusEl(chip('audio')); return true }
      if (key === 'up' || key === 'left') return true
    } else if (active === chip('audio') && key === 'up') { focusEl(playButton.current); return true }
  })

  // ---------- Drawing ----------

  const st = view.open ? s.stream() : undefined
  const shownTime = scrubTo ?? time
  const left = Math.max(0, length - shownTime)
  const ends = new Date(Date.now() + left)
  const subtitle = online ? subs.at(online.cues, time, delay * 1000) : cue
  const shown = controls && !view.loading && !rating
  // An episode: the show and its number above the episode's name ("S2 E7  ·  Name"), as Android
  // (with no "  ·  ", the whole line is the name).
  const cut = episode ? episode.indexOf('  ·  ') : -1
  const number = episode && cut >= 0 ? episode.slice(0, cut).trim() : ''
  const episodeName = episode ? (cut >= 0 ? episode.slice(cut + 5).trim() : episode.trim()) : ''
  // (Worked out again once a second at most, not on every time update: a 2020 TV's CPU.)
  const rowsTick = Math.floor(Date.now() / 1000)
  const rows = useMemo(() => (panel ? panelRows(panel.which, panel.lang) : []), [panel, rowsTick, view, online, delay, fit, episodes])
  const chipList: { key: Panel | 'next'; text: string; icon: IconName }[] = [
    { key: 'audio', text: 'Audio', icon: 'pl_audio' }, { key: 'subtitles', text: 'Subtitles', icon: 'pl_subtitles' },
    { key: 'quality', text: 'Quality', icon: 'pl_quality' }, { key: 'picture', text: 'Picture', icon: 'pl_picture' },
  ]
  const rightChips: { key: Panel | 'next'; text: string; icon: IconName }[] = [
    ...(isEpisode ? [{ key: 'episodes' as const, text: 'Episodes', icon: 'pl_episodes' as const }] : []),
    ...(play?.next ? [{ key: 'next' as const, text: 'Next episode', icon: 'pl_next' as const }] : []),
  ]
  const chipButton = (c: { key: Panel | 'next'; text: string; icon: IconName }) => (
    <button key={c.key} className="player-chip" data-f="" data-chip={c.key}
      // (Skipping ahead mid-episode: this one keeps its place.)
      onClick={() => (c.key === 'next' ? playNext(inCredits()) : openPanel(c.key))}>
      <Icon name={c.icon} size={16} /><span>{c.text}</span>
    </button>
  )

  return (
    <div className="player">
      <div ref={box} className="player-box" />
      {subtitle && !view.loading && <div className={`player-subtitle${shown ? ' raised' : ''}`}>{subtitle}</div>}

      {/* While a file is found and opened, before the film and mid-film alike: the title's picture, its
          name and one calm line. */}
      {view.loading && (
        <div className="player-loading">
          {art && <img className="player-art" src={art} alt="" onError={ev => { ev.currentTarget.style.display = 'none' }} />}
          <span className="player-scrim" />
          <div className="player-loading-text">
            <b className="player-name">{name}</b>
            {episode && <span className="player-episode">{episode}</span>}
            {view.line && <span key={view.line} className="player-status waiting">{view.line}</span>}
          </div>
        </div>
      )}

      <div className={`player-controls${shown ? ' shown' : ''}`} data-inert={shown ? undefined : ''}>
        <span className="player-shade" />
        <div className="player-controls-body">
          {!!episode?.trim() && <span className="player-eyebrow">{[name, number].filter(Boolean).join('  ·  ')}</span>}
          <b className="player-title">{episodeName || name}</b>
          {st && <span className="player-source-line">{releaseLine(st)}</span>}
          <div className="player-line">
            <button ref={playButton} className="player-play" data-f="" aria-label={paused ? 'Play' : 'Pause'} onClick={togglePause}>
              <Icon name={paused ? 'pl_play' : 'pl_pause'} size={20} />
            </button>
            <div ref={timeline} className="timeline" data-f="" tabIndex={0}>
              <span className="timeline-track"><span className="timeline-fill" style={{ transform: `scaleX(${length ? Math.min(1, shownTime / length) : 0})` }} /></span>
              <span className="timeline-knob" style={{ left: `${length ? Math.min(100, (shownTime / length) * 100) : 0}%` }} />
            </div>
          </div>
          <div className="timeline-numbers">
            <span>{clock(shownTime)}</span>
            <span className="muted">Ends at {String(ends.getHours()).padStart(2, '0')}:{String(ends.getMinutes()).padStart(2, '0')}</span>
            <span>−{clock(left)}</span>
          </div>
          <div ref={chips} className="player-chips">
            <div className="player-chips-left">{chipList.map(chipButton)}</div>
            {rightChips.map(chipButton)}
          </div>
        </div>
      </div>

      {panel && <PanelView which={panel.which} rows={rows} chips={chips.current} season={parts[1]} />}

      {upNext != null && play?.next && (
        <div className="up-next">
          {play.next.thumbnail && <img src={play.next.thumbnail} alt="" onError={ev => { ev.currentTarget.style.display = 'none' }} />}
          <div>
            <span className="up-next-label">Up next</span>
            <b>{`${play.next.episode}  ·  ${play.next.name}`}</b>
            <button className="player-chip focused" tabIndex={-1}>▶  Play now  ·  {upNext}</button>
          </div>
        </div>
      )}

      {rating && (
        <RatingCard title={name} closing={rateClosing}
          choices={[
            { icon: 'rate_down', text: 'Not for me', run: () => rate(-1, 'Not for me') },
            { icon: 'rate_up', text: 'I like it', run: () => rate(1, 'I like it') },
            { icon: 'rate_love', text: 'Love it', run: () => rate(2, 'Love it') },
          ]} />
      )}

      {earlyExit && (
        <div className="player-dim">
          {/* (Just leaving comes first, and has focus, so OK pressed out of habit doesn't say "not for me".) */}
          <Choices title={[name, episode].filter(Boolean).join('  ·  ')} footer="Back to leave without answering"
            choices={[
              { icon: 'act_later', text: "I'll finish later", run: () => exitWith('later') },
              { icon: 'rate_down', text: 'Not for me', run: () => exitWith('not_for_me') },
            ]} />
        </div>
      )}

      {view.card && (
        <div className="player-dim">
          <Choices key={view.card} title={view.card === 'keepTrying' ? COULDNT_PLAY_NOW : OTHER_EPISODES} wrap
            choices={[
              view.card === 'keepTrying'
                ? { icon: 'pl_play', text: 'Keep trying', run: () => s.keepTrying() }
                : { icon: 'pl_play', text: 'Play', run: () => s.playOtherEpisodes() },
              { icon: 'act_close', text: 'Back', run: () => leave() },
            ]} />
        </div>
      )}

      {/* Mid-film, waiting for the file, or for audio just switched to: a small spinner. */}
      {!view.loading && (spinner || switching) && <span className="player-spinner" />}

      {view.held ? <span className="player-note">{view.held}</span>
        : note && <span key={note.n} className={`player-note${note.out ? ' out' : ''}`}>{note.text}</span>}
    </div>
  )
}

/** Whether an HLS stream is played through hls.js: a plugin's stream the server says a web page may not
 * read (no CORS) is given to the TV's own player instead, which needs none. */
function hlsJs(st: Stream | undefined) {
  if (!st) return false
  if (st.plugin) return st.browser !== false
  return st.hls === true
}

/** The release line under the title (the Android TV's): quality, HDR, release and a language other than
 * English; a plugin's stream adapts its quality ("Auto quality"); never the file's name. */
function releaseLine(st: Stream) {
  const langs = st.languages ?? []
  const spoken = !langs.length || (langs.length === 1 && langs[0] === 'en') ? null : langs.map(c => SPOKEN[c] ?? c.toUpperCase()).join(' + ')
  return [st.resolution, ...(st.hdr ?? []), st.source, spoken].filter(x => !!x && x !== 'null').join('  ·  ')
    || (st.plugin ? 'Auto quality' : '')
}

const timing = (d: number) => (Math.abs(d) <= 0.05 ? 'In sync  ·  ◀ ▶ to adjust'
  : `${d > 0 ? '+' : ''}${d.toFixed(1)} s  ·  ${d > 0 ? 'shown later' : 'shown earlier'}  ·  ◀ ▶ to adjust`)

/** A panel, just above its chip: focus on the chosen row, else the first. */
function PanelView({ which, rows, chips, season }: { which: Panel; rows: Row[]; chips: HTMLElement | null; season?: string }) {
  const list = useRef<HTMLDivElement>(null)
  const chip = chips?.querySelector<HTMLElement>(`[data-chip="${which}"]`)
  const r = chip?.getBoundingClientRect()
  const remPx = parseFloat(getComputedStyle(document.documentElement).fontSize)
  const stage = document.getElementById('root')?.getBoundingClientRect()
  const left = r && stage ? Math.max(24, (r.left - stage.left) / remPx) : 56
  const bottom = r && stage ? Math.max(0, (stage.bottom - r.top) / remPx + 10) : 120
  const keyOf = rows.map(x => x.key).join('|')
  const shownFor = useRef<Panel | null>(null)
  useEffect(() => {
    const el = list.current
    if (!el) return
    // (The same panel filling in, more sources bringing a language: the row you're on stays yours.)
    const on = document.activeElement as HTMLElement | null
    if (shownFor.current === which && on && el.contains(on) && on.dataset.key && rows.some(x => x.key === on.dataset.key)) return
    shownFor.current = which
    // (From the top, so Off and Timing stay in view; focusing scrolls only as far as needed.)
    el.scrollTop = 0
    focusEl(el.querySelector<HTMLElement>('[data-chosen]') ?? el.querySelector<HTMLElement>('[data-f]'))
  }, [which, keyOf])
  const title = which === 'audio' ? 'Audio' : which === 'subtitles' ? 'Subtitles' : which === 'quality' ? 'Quality'
    : which === 'picture' ? 'Picture' : `Season ${season ?? ''}`
  return (
    <div className={`player-panel${which === 'episodes' ? ' wide' : ''}`} style={{ left: `${Math.min(left, which === 'episodes' ? 556 : 636)}rem`, bottom: `${bottom}rem` }} data-scope="">
      <b className="player-panel-title">{title}</b>
      <div ref={list} className="player-panel-list">
        {rows.map(x => x.header ? <span key={x.key} className="player-panel-header">{x.label}</span> : (
          <button key={x.key} className="player-panel-row" data-key={x.key} data-f="" data-chosen={x.chosen ? '' : undefined} data-adjust={x.adjust ? '' : undefined}
            onClick={x.run}>
            <span className="tick">{x.chosen ? '✓' : ''}</span>
            {x.still !== undefined && (
              <span className="player-panel-still">
                {x.still && <img src={x.still} alt="" />}
                {x.progress != null && <i style={{ width: `${Math.round(Math.min(1, Math.max(0, x.progress)) * 100)}%` }} />}
              </span>
            )}
            <span className="player-panel-text"><span className={x.waiting ? 'waiting' : undefined}>{x.label}</span>{x.detail && <small>{x.detail}</small>}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

/** The rating card (the Android TV's): in the middle over a soft dimming, a glass card (How was it?,
 * the title in the display font) with the live player's glass discs. Left/Right, OK; I like it first. */
function RatingCard({ title, choices, closing }: { title: string; closing: boolean; choices: { icon: IconName; text: string; run: () => void }[] }) {
  const row = useRef<HTMLDivElement>(null)
  // (After the key that brought it up has done its work: I like it.)
  useEffect(() => { const t = setTimeout(() => focusEl(row.current?.children[1] as HTMLElement | undefined), 0); return () => clearTimeout(t) }, [])
  return (
    <div className={`rate-scrim${closing ? ' closing' : ''}`}>
      <div className="rate-box" data-scope="">
        <span className="rate-eyebrow">How was it?</span>
        <b className="rate-title">{title}</b>
        <div ref={row} className="rate-choices">
          {choices.map(c => (
            <button key={c.text} className="rate-choice" data-f="" onClick={c.run}>
              <span className="rate-choice-box"><span className="rate-halo" /><span className="rate-disc"><Icon name={c.icon} size={22} /></span></span>
              <span className="rate-label">{c.text}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

/** A card of choices side by side, centred over the dimmed picture (leaving early, Keep trying, Play one
 * anyway): Left/Right, OK; the first focused. [wrap]: its line may take two. */
function Choices({ title, footer, choices, wrap }: {
  title: string; footer?: string; wrap?: boolean; choices: { icon: IconName; text: string; run: () => void }[]
}) {
  const row = useRef<HTMLDivElement>(null)
  useEffect(() => { const t = setTimeout(() => focusEl(row.current?.children[0] as HTMLElement | undefined), 0); return () => clearTimeout(t) }, [])
  return (
    <div className="player-card" data-scope="">
      <b className={`player-card-title${wrap ? ' wrap' : ''}`}>{title}</b>
      <div ref={row} className="player-card-choices">
        {choices.map(c => (
          <button key={c.text} className="player-choice" data-f="" onClick={c.run}><Icon name={c.icon} size={20} /><span>{c.text}</span></button>
        ))}
      </div>
      {footer && <span className="player-card-footer">{footer}</span>}
    </div>
  )
}
