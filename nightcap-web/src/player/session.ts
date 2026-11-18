/**
 * The web player's play: which file is opened, how its link is asked about, how it fails, waits and gives
 * up, and what the viewer is told. The Android TV's player, rule for rule,
 * without the drawing: the page (screens/Player.tsx)
 * draws the view this keeps, plays the file it asks for, and tells it what the video does.
 *
 * Every ask, check and wait carries an attempt number (opening): once another file is being opened, its
 * answer is dropped, so a late answer never starts the wrong file. Before a card, a wait or an ask, the
 * video stops, so nothing plays behind the screen.
 *
 * What a browser can't do, it doesn't: it looks at a file's address as the TV does only as far as the host
 * lets a page read its answer, and tells the server a file is gone only on a 404 or 410 it read (a video
 * error doesn't prove it).
 */

import type { LinkAnswer } from './link'
import * as PlayOrder from '../playOrder'
import { suspect, type Play, type Stream, type Subtitle } from '../types'
import { SPOKEN, languageName } from './languages'

export { SPOKEN, languageName, namedLanguage, trackLanguages } from './languages'

// ---------- Words ----------

export const NOTHING_YET = 'No sources found for this one yet. Try again later.'
export const COULDNT_FIND = "Couldn't find sources right now. Try again in a moment."
export const BEING_PREPARED = 'This one is being prepared. Try again in a few minutes.'
export const COULDNT_PLAY = "Couldn't play this right now. Try again in a moment."
export const COULDNT_PLAY_NOW = "Couldn't play this right now."
export const GETTING_READY = 'Getting it ready…'
export const STILL_GETTING_READY = 'Still getting it ready…'
export const ALMOST_THERE = 'Almost there…'
export const TOO_MANY_REQUESTS = 'Too many requests right now. Try again in a few minutes.'
export const ACCOUNT_PROBLEM = "There's a problem with your streaming account."
export const RECONNECTING = 'Reconnecting…'
export const SWITCHING = 'Switching…'
export const SWITCHING_BACK = 'Switching back…'
export const TRY_ANOTHER = 'Try another version'
export const MAY_NOT_BE_RIGHT = 'May not be right'
export const OTHER_EPISODES = 'Only other episodes were found. Play one anyway?'
export const NO_CONNECTION = "Lost the connection. Try again once it's back."
/** Web only: nothing here plays in a browser (the viewer can act on it: the TV app). Not "plays on the
 * TV app": the files weren't tried, so whether they play anywhere isn't known. */
export const NOT_IN_BROWSER = "Doesn't play in this browser · Try the TV app"
/** Samsung/LG only: nothing here plays on this TV (a sound or picture it can't decode). */
export const NOT_ON_THIS_TV = "Doesn't play on this TV"

// ---------- Times ----------

const BUDGET_START_MS = 180_000
const BUDGET_AFTER_MS = 120_000
const START_TIMEOUT_MS = 30_000
const PICK_START_TIMEOUT_MS = 15_000
const LINKS_MARGIN_MS = 60_000
const PREPARING_AFTER_ANSWER_MS = 60_000
const PREPARING_AGAIN_MS = 61_000
const BUSY_WAIT_HERE_MS = 15_000
const WAIT_MARGIN_MS = 250
const MAX_FOLLOWED_OPENS = 15
const FEW_LEFT = 3
const MAX_RECONNECTS = 3
const KEEP_BEFORE_MS = 15_000
/** How long a note that something went wrong (or a version was gone back from) stays: long enough to read. */
export const BACK_NOTE_MS = 5_000
const NOTE_MS = 1_800
/** Where a play resumes counts from this far in (earlier: from the start, nothing said). */
const START_GRACE_MS = 5_000
const CLEAN_PLAY_MS = 10 * 60_000
const STILL_AFTER_MS = 8_000
const ALMOST_AFTER_MS = 60_000
const OFFLINE_WAIT_MS = 120_000
const OFFLINE_LOOKBACK_MS = 30_000
const STARTING_WAIT_MS = 90_000
/** How long a link ask waits for the server's answer (it follows the add-on itself, 15 s at most). */
const ASK_TIMEOUT_MS = 25_000
/** The look at a debrid host's address: one byte asked, this long a call. */
const HOST_CHECK_MS = 8_000
/** After a look that got nothing back: a plain ask (no preflight), this long more. */
const PLAIN_CHECK_MS = 4_000
const SHORTEST_PART = 0.4
const MIN_UNKNOWN_LENGTH_MS = 90_000
const DROPPED_BEFORE_END_MS = 3 * 60_000
const VERSIONS_CHECKED = 4
/** A track switched to in a file: "Switching to Hindi…" goes once it's heard, or after this at most. */
const SWITCH_MOST_MS = 5_000
/** The file whose download was started for a title (its first open had only files not downloaded yet) is
 * remembered this long, so the next open tries it first (as the Android TV does). In memory only. */
const PREPARING_KEPT_MS = 30 * 60_000
const preparingStarted = new Map<string, { key: string; at: number }>()
function preparingKey(videoId: string) {
  const p = preparingStarted.get(videoId)
  if (!p) return null
  if (Date.now() - p.at > PREPARING_KEPT_MS) { preparingStarted.delete(videoId); return null }
  return p.key
}
const TOKEN = /\/s\/([A-Za-z0-9_-]{16,64})\/\d+/

export const QUALITIES = ['4K', '1080p', '720p', '480p']
export const QUALITY_NAMES: Record<string, string> = { '4K': '4K', '1080p': '1080p', '720p': '720p', '480p': 'SD' }


// ---------- What the page sees ----------

/** A file to play: its address (already asked about), from where, for how long it may take to start. */
export type Open = { attempt: number; index: number; url: string; at: number; timeoutMs: number; youtube?: string }
export type Card = 'keepTrying' | 'otherEpisodes'
export type View = {
  play?: Play
  /** The loading screen is up (before the first picture, or mid-film while a file changes). */
  loading: boolean
  /** Its one line, breathing while it waits; null: nothing to say yet. */
  line: string | null
  /** Something has played this play (the loading screen shows over the picture, not the art). */
  everStarted: boolean
  /** The file to play now, or null (stopped: nothing plays behind a card or a wait). */
  open: Open | null
  card: Card | null
  /** The play is over: these words, and Back (and Play on TV where it can). */
  ended: string | null
  /** A note over the picture ("Hindi audio is available now"), and one held until let go ("Switching to Hindi…"). */
  note: { text: string; n: number; ms: number } | null
  held: string | null
  current: number
}

/** What the page can tell about the audio of the file playing (the smart way reads its tracks): each
 * track's language, the one playing, and which the page can switch to. */
export type Tracks = { languages: (string | null)[]; playing: number; switchable?: boolean[]; names?: (string | null)[] } | null

const commentary = (name: string | null | undefined) => !!name && /comment/i.test(name)


// The next episode's play answer, asked for in this one's last minutes so it starts without the wait for
// sources (as the Android TV does): one at a time, for its path; every source too when it hasn't the picked language.
const AHEAD_MAX_AGE_MS = 15 * 60_000
let ahead: { path: string; at: number; answer: Promise<Play>; more?: Promise<Play> } | null = null

export type Carry = {
  /** The audio pick (a code, "" cleared, undefined none), the quality, a language a binge lacks, the
   * "isn't available" line said, the subtitles. */
  pick?: string; quality?: string; wantMissing?: string; lineSaid?: boolean; subs?: string
  /** A picked track that doesn't say its language: its release (bingeGroup) and number, "group|n". */
  track?: string
}

type Where =
  | { t: 'at'; url: string; direct: boolean } | { t: 'expired' } | { t: 'gone' } | { t: 'notNow' } | { t: 'preparing' }
  | { t: 'busy'; service: string; kind: string | null; until: number }
  | { t: 'refused'; service: string; kind: string | null; why: string } | { t: 'offline' }
type Asked = { where: Where; pausedMs: number; wentOffline: number }
type Before = { index: number; at: number; want: string | null; language: string | null; heard: string | null
  quality: string | null; wasQuality: string | null; qualityWant: string | null }
type More = 'none' | 'offered' | 'looking'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

type Check = 'open' | 'dead' | 'afresh' | 'notNow' | 'silent'

/** One look at an address: its status when the page may read it (cors), else only whether it answered in
 * [ms] (no-cors: no preflight, nothing read, the download stopped at once). */
async function look(url: string, cors: boolean, ms: number): Promise<{ status: number; retryAfter: number } | 'silent' | 'unreadable' | 'unreachable'> {
  const abort = new AbortController()
  const t = setTimeout(() => abort.abort(), ms)
  try {
    const r = await fetch(url, {
      signal: abort.signal, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer',
      ...(cors ? { headers: { Range: 'bytes=0-0' } } : { mode: 'no-cors' }),
    })
    if (r.type === 'opaque') return 'unreadable'
    return { status: r.status, retryAfter: Number(r.headers.get('Retry-After')) || 2 }
  } catch {
    // (A plain ask that fails outright: the host can't be found or refuses; a page's own ask, maybe only
    // not let read.)
    return abort.signal.aborted ? 'silent' : cors ? 'unreadable' : 'unreachable'
  } finally {
    clearTimeout(t)
    // (Only the answer's start was wanted.)
    abort.abort()
  }
}

/**
 * What the session needs from the app it runs in: the web app or the Samsung/LG app (one session, two
 * apps). Everything else in here is the same for both. The TV app
 * relies on every member as written.
 */
export type Host = {
  /** The play answer. Throws on any failure. */
  play(type: string, videoId: string, o: { binge?: string | null; more?: boolean; audio?: string | null }): Promise<Play>
  /** Where a playback link leads (link.ts's askLink): AbortError when [signal] fires, TypeError offline. */
  askLink(link: string, signal: AbortSignal): Promise<LinkAnswer>
  /** New links for the same files. TypeError when there's no connection, and only then (a timeout isn't). */
  renewLinks(token: string, runtimeMs: number): Promise<{ token: string; linksExpireAt: number }>
  /** Each version's audio languages, read from its own tracks (null: unread). */
  audioLanguages(links: string[]): Promise<{ languages: (string[] | null)[] }>
  sourceFailed(id: string, addon: string, why: string, filename?: string): void
  sourcePlayed(id: string, key: string): void
  sourceGone(id: string, addon: string, key: string): void
  /** Whether this app can play the stream at all. */
  canPlay(s: Stream): boolean
  /** Whether this app can switch among a file's own audio tracks (before its service's files proved
   * unreadable: see unreadable()). */
  tracksSwitchable(s: Stream): boolean
  /** The ending when nothing found can play here. */
  nothingPlaysHere: string
  /** "Not out yet. Comes out 8 Nov 2026" for a release date ("2026-11-08", "" when not known). */
  notOutYet(releases: string): string
  /** Whether a file may be opened in a track by its place in the server's reading of its header, when
   * the counts agree (as the Android TV does). */
  headerIndexes: boolean
  /** Who's watching (a profile's id): the next episode's answer asked ahead is theirs only. */
  profileKey(): string
}

export class Session {
  view: View = { loading: true, line: null, everStarted: false, open: null, card: null, ended: null, note: null, held: null, current: -1 }
  private listener: (v: View) => void = () => {}
  private gone = false
  private noteN = 0

  // The play.
  private type: string; private videoId: string; private binge: string | null
  private play_?: Play
  private streams: Stream[] = []
  private keys: string[] = []
  private subtitles: Subtitle[] = []
  private current = -1
  private resumeAt = 0
  private expectedMs = 0
  private notice: string | null = null
  private profileAudio: string[] = []
  private linksExpireAt = 0
  private answeredAt = 0

  // The walk through the files.
  private tried = new Set<string>()
  private played = new Set<string>()
  private broke = new Set<string>()
  private ruledOut = new Set<string>()
  private rejected = new Set<string>()
  private failedAt = new Map<string, number>()
  private preparingAt = new Map<string, number>()
  private trips: PlayOrder.Trip[] = []
  private followedOpens = 0
  private opening = 0
  private budgetEnd = Date.now() + BUDGET_START_MS
  private readonly openedAt = Date.now()
  private started = false
  private everStarted = false
  private lastGood = -1
  private reconnects = 0
  private renewedFor: string | null = null
  private lookedAgainFor: string | null = null
  private carryOn: { key: string; at: number; beforeKey: string | null } | null = null
  private triedDeadWant = false
  private resumedSaid = false
  private unreadableFiles = new Map<string, Set<string>>()
  private prefetched: string | null = null
  private switchedAnyway?: ReturnType<typeof setTimeout>
  /** The file whose download was started on an earlier open of this title (tried first), if any. */
  private preparing: string | null = null
  private switching = false
  private waitedForWant = false
  private preparedOnce = false
  private otherAsked = false
  private otherOk = false
  private more: More = 'none'
  private askedMore = false
  private moreWaiters: ((added: number) => void)[] = []
  /** Every source for this episode, asked for in the last one's last minutes (the picked language missing). */
  private aheadMore: Promise<Play> | null = null
  private before: Before | null = null
  private wentBack: string | null = null
  private startNote: string | null = null
  private startTimeout = START_TIMEOUT_MS
  private timers = new Set<ReturnType<typeof setTimeout>>()
  private stalled?: ReturnType<typeof setTimeout>
  private stillTimer?: ReturnType<typeof setTimeout>
  private versionLook = 0
  private lookingFor: string | null = null

  // Language and quality.
  /** The language picked in the player (null: none); the pick as carried (code, "" cleared, null none). */
  audioWant: string | null = null
  private pickState: string | null = null
  private pickToSave: string | null = null
  private pickHeard = false
  private pendingPick: string | null = null
  qualityWant: string | null = null
  private wantMissing: string | null = null
  private lineSaid = false
  private availableSaid = false
  private tracks: Tracks = null
  /** The audio track playing (its file's key, its place among the file's audio tracks), so the same file
   * opened again (a reconnect) carries on in it; and a picked track that doesn't say its language, carried
   * through the binge in the same release ("group|n"). */
  private pickedTrack: { key: string; index: number } | null = null
  private carriedTrack: string | null = null
  /** The subtitles wanted for this show ("eng", "off"), and a pick not yet saved. */
  subsPick: string | null = null
  private subsToSave: string | null = null
  private profileSubs: string | null = null

  private host: Host

  constructor(type: string, videoId: string, binge: string | null, carried: Carry, profileSubs: string | null, host: Host) {
    this.host = host
    this.type = type
    this.videoId = videoId
    this.binge = binge
    this.pickState = carried.pick ?? null
    this.audioWant = carried.pick ? carried.pick : null
    this.qualityWant = carried.quality ?? null
    this.wantMissing = carried.wantMissing ?? null
    this.lineSaid = !!carried.lineSaid
    this.subsPick = carried.subs ?? null
    this.carriedTrack = carried.track ?? null
    this.profileSubs = profileSubs
    // A minute in with nothing played, still waiting: "Almost there…".
    this.later(() => { if (!this.everStarted && this.view.line === STILL_GETTING_READY) this.set({ line: ALMOST_THERE }) }, ALMOST_AFTER_MS)
  }

  onChange(fn: (v: View) => void) { this.listener = fn; fn(this.view) }

  isClosed = () => this.gone

  /** The page is closing: nothing more is done or said. */
  close() {
    this.gone = true
    this.opening++
    for (const t of this.timers) clearTimeout(t)
    clearTimeout(this.stalled)
    clearTimeout(this.stillTimer)
  }

  private set(change: Partial<View>) {
    if (this.gone) return
    this.view = { ...this.view, ...change, current: this.current, everStarted: this.everStarted }
    this.listener(this.view)
  }

  private later(fn: () => void, ms: number) {
    const t = setTimeout(() => { this.timers.delete(t); if (!this.gone) fn() }, Math.max(0, ms))
    this.timers.add(t)
    return t
  }

  // ---------- Loading ----------

  /** Asks for the play answer (and, after links ran out that couldn't be renewed, carries on). */
  async load() {
    // (After links ran out mid-film, the screen already says "Reconnecting…".)
    if (!this.carryOn) this.say(GETTING_READY)
    const attempt = this.opening
    let p: Play | null = null
    // (Asked for in the last episode's last minutes: taken at once, unless it failed or found nothing, then
    // asked again. Not for links that ran out mid-film: that's this episode's own answer.)
    if (!this.carryOn) {
      const path = aheadPath(this.type, this.videoId, this.binge, this.pickState, this.host.profileKey())
      const taken = ahead && ahead.path === path && Date.now() - ahead.at < AHEAD_MAX_AGE_MS ? ahead : null
      if (taken) ahead = null
      const got = taken ? await taken.answer.catch(() => null) : null
      if (got && (got.streams.length || got.releases != null)) { p = got; this.aheadMore = taken?.more ?? null }
    }
    try {
      // (A reload after the links expired asks for every source again when this play had them all.)
      p ??= await this.host.play(this.type, this.videoId, { binge: this.binge, audio: this.pickState ?? '*', more: !!this.carryOn && this.askedMore })
    } catch {
      if (this.gone || attempt !== this.opening) return
      return this.end(COULDNT_FIND)
    }
    // (Another file was started meanwhile, a pick from a panel left open: this answer is dropped.)
    if (this.gone || attempt !== this.opening) return
    this.answer(p)
    this.answeredAt = Date.now()
    // New links after the old ones expired: the same source again (or the one in its place), from where it was.
    const carry = this.carryOn
    if (carry) {
      this.carryOn = null
      // (The one to go back to, in the new list by its key; gone from it: none.)
      const b = this.before
      const bi = carry.beforeKey != null ? this.keys.indexOf(carry.beforeKey) : -1
      this.before = b && bi >= 0 ? { ...b, index: bi } : null
      // (The same file by its key; gone from the new list: the next by the usual order, never whatever
      // sits at the same place.)
      const same = this.keys.indexOf(carry.key)
      const i = same >= 0 ? same : this.nextToTry()
      if (i >= 0) return this.playFile(i, carry.at)
    }
    if (p.releases != null) return this.set({ loading: true, line: null, ended: this.host.notOutYet(p.releases) })
    if (!this.streams.length) return this.nothingToPlay()
    // The file whose download was started on an earlier open of this title: tried first.
    this.preparing = preparingKey(this.videoId)
    const first = this.nextToTry(this.preparing)
    if (first < 0) return this.nothingToPlay()
    // The wanted language isn't among these files: more are asked for straight away.
    const want = this.audioWant
    if (want && this.wantMissing !== want && !this.streams.some((_, i) => this.speaks(i, want))) {
      this.lookForMoreQuietly(() => {
        if (this.more === 'none' && !this.streams.some((_, i) => this.speaks(i, want))) this.wantMissing = want
      })
    }
    // (A file asked for first, one being prepared, is kept.)
    this.playFile((this.preparing ? null : this.deadWantInstead(first)) ?? first, this.resumeAt)
  }

  private answer(p: Play) {
    this.play_ = p
    this.streams = p.streams
    this.keys = keysOf(p.streams)
    this.subtitles = p.subtitles
    this.resumeAt = p.resume > 5_000 ? p.resume : 0
    this.expectedMs = p.runtimeMs ?? 0
    this.notice = p.notice ?? null
    this.linksExpireAt = p.linksExpireAt ?? 0
    // (A look for more under way keeps going: its answer is still merged.)
    if (this.more !== 'looking') this.more = p.moreSources ? 'offered' : 'none'
    // The profile's audio language (the server ranked by it), then the title's own.
    this.profileAudio = [...new Set([p.audioLanguage, p.originalLanguage].filter((x): x is string => !!x))]
    // What this profile picked for this show before (none carried over): wanted again. The same for subtitles.
    if (this.subsPick == null) this.subsPick = p.titleSubtitles ?? null
    if (this.pickState == null && p.titleAudio) { this.pickState = p.titleAudio; this.audioWant = p.titleAudio }
    this.set({ play: p })
  }

  // ---------- The order ----------

  private keyAt = (i: number) => this.keys[i] ?? ''
  private original = () => this.profileAudio[this.profileAudio.length - 1] ?? null

  /** Whether a browser can play stream [i] at all (as it is, or the smart way). */
  /** A file's languages as this browser can play them: every track the smart way can pick, else the first
   * (a browser's own player plays the first). From its header when read, else its name. */
  private fileLangs(s: Stream): string[] {
    // (Without the smart way, a browser plays the first track: a file counts for its first language only.)
    if (s.fileAudio?.length) return this.smartPossible(s) ? s.fileAudio : s.fileAudio.slice(0, 1)
    return this.smartPossible(s) ? s.languages ?? [] : (s.languages ?? []).slice(0, 1)
  }

  /** Whether this app can switch among the file's own tracks (it can at all, and its service's files could be read). */
  private smartPossible(s: Stream) {
    return this.host.tracksSwitchable(s) && !(s.service && (this.unreadableFiles.get(s.service)?.size ?? 0) >= 2)
  }

  /** The file being opened couldn't be read by this browser (its host sends no CORS headers): after two of a
   * service's files, this play counts that service's files for their first track only. */
  unreadable(attempt: number) {
    const st = this.streams[this.current]
    if (attempt !== this.opening || !st?.service) return
    const seen = this.unreadableFiles.get(st.service) ?? new Set<string>()
    seen.add(this.keyAt(this.current))
    this.unreadableFiles.set(st.service, seen)
  }

  private browserOk = (s: Stream) => this.host.canPlay(s)

  /** The play answer's sources as the order sees them. */
  private orderFiles(): PlayOrder.File[] {
    const now = Date.now()
    // (A busy window that has ended: its files are tried in their places again.)
    const live = this.trips.filter(t => t.type !== 'busy' || t.until > now)
    return PlayOrder.apply(this.streams.map((s, i) => ({
      key: this.keyAt(i), verified: s.verified !== false, suspect: suspect(s), notDownloaded: s.cached === false,
      openable: (!!s.youtube || !!s.url) && this.browserOk(s),
      languages: this.fileLangs(s), fromHeader: !!s.fileAudio?.length, resolution: s.resolution,
      service: s.service ?? null, kind: s.kind ?? null, seen: !!s.seen, dead: !!s.dead,
      preparingUntil: (() => { const t = this.preparingAt.get(this.keyAt(i)); return t != null && t > now ? t : null })(),
    })), live)
  }

  private speaks = (i: number, lang: string | null) => PlayOrder.speaks(this.orderFiles()[i], lang, this.original())

  /** A source whose link the server follows (a debrid call), unlike a direct file, a plugin's or YouTube. */
  private followed = (i: number) => { const s = this.streams[i]; return !!s && !s.direct && !s.plugin && !s.youtube }

  /** The files not to try now: those tried, and at the cap every followed one (direct, plugins, YouTube go on). */
  private skip(capped = true) {
    if (!capped || this.followedOpens < MAX_FOLLOWED_OPENS) return this.tried
    return new Set([...this.tried, ...this.streams.map((_, i) => i).filter(this.followed).map(this.keyAt)])
  }

  private nextToTry(first: string | null = null, capped = true) {
    return PlayOrder.next(this.orderFiles(), this.skip(capped), {
      want: this.audioWant, quality: this.qualityWant, original: this.original(),
      allowed: new Set(first ? [first] : []), first, now: Date.now(),
    })
  }

  // ---------- Opening a file ----------

  /** Whether a source's link is asked about first: the server's playback links, not a plugin's. */
  private asksFirst = (s: Stream) => !s.plugin && !!s.url && TOKEN.test(s.url)

  /** Plays source [index] from [at] ms. [address]: where its link leads, already asked (a reconnect). */
  private playFile(index: number, at: number, address?: string, timeout = START_TIMEOUT_MS) {
    this.startTimeout = timeout
    if (index !== this.current) {
      this.reconnects = 0
      // (A file's own track order: the wanted language's place in this one is worked out again.)
      if (this.current >= 0) this.pickedTrack = null
    }
    this.current = index
    // (Its own tracks, once the page reads them: never the last file's.)
    this.tracks = null
    this.tried.add(this.keyAt(index))
    // (A followed link costs a debrid call: at most so many per play.)
    if (this.followed(index)) this.followedOpens++
    this.started = false
    const s = this.streams[index]
    const attempt = ++this.opening
    clearTimeout(this.stalled)
    this.stalled = setTimeout(() => this.stall(attempt), START_TIMEOUT_MS)
    if (s.youtube) return this.open(index, '', at, s.youtube)
    if (address != null || !this.asksFirst(s)) return this.open(index, address ?? s.url!, at)
    // Where its link leads is asked first, so a file that's gone, busy or being prepared is told in a
    // second, not in 30. What was playing stops meanwhile.
    clearTimeout(this.stalled)
    this.set({ open: null })
    this.whereItLeads(s.url!, attempt).then(asked => {
      if (!this.gone && attempt === this.opening) this.whereCame(asked, at, true)
    })
  }

  private open(index: number, url: string, at: number, youtube?: string) {
    const attempt = this.opening
    clearTimeout(this.stalled)
    this.stalled = setTimeout(() => this.stall(attempt), this.startTimeout)
    this.set({ open: { attempt, index, url, at, timeoutMs: this.startTimeout, youtube } })
  }

  private stall(attempt: number) {
    if (attempt === this.opening && !this.started && !this.gone) this.failed("didn't start")
  }

  /** The page gave the video its source (after looking into the file): its time to start counts from now. */
  begin(attempt: number) {
    if (attempt !== this.opening || this.started) return
    clearTimeout(this.stalled)
    this.stalled = setTimeout(() => this.stall(attempt), this.startTimeout)
  }

  /** Which file is being opened (the page drops a video's events once another is). */
  attemptNow = () => this.opening

  /** The video waits for a click to start (the browser blocked playing by itself): it isn't stuck. */
  blocked(attempt: number) {
    if (attempt === this.opening) clearTimeout(this.stalled)
  }
  unblocked(attempt: number) {
    if (attempt !== this.opening || this.started) return
    clearTimeout(this.stalled)
    this.stalled = setTimeout(() => this.stall(attempt), this.startTimeout)
  }

  /** Where a playback link leads now (X-Where: 2), waiting while the server wakes up (90 s at most), the
   * connection is down (2 min) or the file's service is briefly busy (once, 15 s at most). */
  private async whereItLeads(link: string, attempt: number): Promise<Asked> {
    let paused = 0, offlineSince = 0, wentOffline = 0, startingSince = 0, waitedBusy = false, waitedOnce = false
    while (attempt === this.opening && !this.gone) {
      const abort = new AbortController()
      const t = setTimeout(() => abort.abort(), ASK_TIMEOUT_MS)
      let a: LinkAnswer | undefined
      try {
        a = await this.host.askLink(link, abort.signal)
      } catch (e) {
        // A slow answer isn't no connection: not this file now, the next.
        if ((e as Error).name === 'AbortError') return { where: { t: 'notNow' }, pausedMs: paused, wentOffline }
      } finally {
        clearTimeout(t)
      }
      const now = Date.now()
      if (a) offlineSince = 0
      const service = a?.header('X-Service') || null
      const kind = a?.header('X-Kind') || null
      const sleepMs = Math.min(15_000, Math.max(1_000, (a?.retryAfter ?? 5) * 1000))
      const done = (where: Where): Asked => ({ where, pausedMs: paused, wentOffline })
      if (!a) {
        // No answer at all: no connection (or the server can't be reached). Waited out a while.
        if (!offlineSince) offlineSince = now
        if (!wentOffline) wentOffline = now
        if (now - offlineSince > OFFLINE_WAIT_MS) return done({ t: 'offline' })
        paused += sleepMs
      } else if (a.status === 200) {
        return done(a.where?.url ? { t: 'at', url: a.where.url, direct: !!a.where.direct } : { t: 'notNow' })
      } else if (a.status === 410) {
        return done({ t: 'expired' })
      } else if (a.status === 502) {
        if (a.header('X-Dead') === 'file') return done({ t: 'gone' })
        if (a.header('X-Dead') === 'account' && service) return done({ t: 'refused', service, kind, why: a.header('X-Why') || 'key' })
        if (a.header('X-Preparing') != null) return done({ t: 'preparing' })
        return done({ t: 'notNow' })
      } else if (a.status === 503 && a.header('X-Starting') != null) {
        // Waking up: the same file once it's up.
        if (!startingSince) startingSince = now
        if (now - startingSince > STARTING_WAIT_MS) return done({ t: 'notNow' })
        paused += sleepMs
      } else if (a.status === 503 && a.header('X-Busy') != null && service) {
        // The household's service is busy: a short wait on the same file, once; a longer one, its files wait.
        const wait = (a.retryAfter ?? 5) * 1000
        if (waitedBusy || wait > BUSY_WAIT_HERE_MS) return done({ t: 'busy', service, kind, until: now + wait })
        waitedBusy = true
      } else if (a.status === 503) {
        // Busy about this one file: once more in a moment.
        if (waitedOnce) return done({ t: 'notNow' })
        waitedOnce = true
      } else {
        return done({ t: 'notNow' })
      }
      await sleep(sleepMs)
    }
    return { where: { t: 'notNow' }, pausedMs: paused, wentOffline }
  }

  /** What the server said about the link of the file being opened ([fromPlay]: from playFile, whose
   * bookkeeping is done; otherwise a reconnect's). */
  private whereCame(asked: Asked, at: number, fromPlay: boolean, afresh = false) {
    // (The server waking or the connection down: that time isn't the play's.)
    if (this.budgetEnd !== Infinity) this.budgetEnd += asked.pausedMs
    // The connection was down: files that failed just before it went were the connection's, and are tried again.
    if (asked.wentOffline > 0) {
      for (const [k, t] of [...this.failedAt]) {
        if (k !== this.keyAt(this.current) && asked.wentOffline - t >= 0 && asked.wentOffline - t <= OFFLINE_LOOKBACK_MS) {
          this.tried.delete(k)
          this.failedAt.delete(k)
        }
      }
    }
    const key = this.keyAt(this.current)
    const w = asked.where
    switch (w.t) {
      case 'at':
        return this.checkThenOpen(w.url, w.direct, at, fromPlay, afresh)
      case 'expired': {
        // (No debrid call was made for it.)
        if (fromPlay && this.followed(this.current)) this.followedOpens--
        // Renewed once for this file: expired again, a fresh play answer instead.
        if (this.renewedFor === key) return this.lookAgainOnce(key, at)
        this.renewedFor = key
        const attempt = this.opening
        return void this.renewLinks().then(ok => {
          if (this.gone || attempt !== this.opening) return
          if (!ok) return this.lookAgainOnce(key, at)
          if (fromPlay) this.playFile(this.current, at)
          else { this.reconnects--; this.reconnect(at) }
        })
      }
      case 'gone': return this.failed('gone', { retry: false, network: false })
      case 'notNow': return this.failed("couldn't be had just now", { retry: false })
      case 'preparing':
        // Being prepared: tried once more, a minute on (the second time, it stays tried).
        if (!this.preparingAt.has(key)) {
          this.preparingAt.set(key, Math.max(this.answeredAt + PREPARING_AFTER_ANSWER_MS, Date.now() + PREPARING_AGAIN_MS))
          this.tried.delete(key)
        } else this.preparingAt.delete(key)
        // (Not ruled out for good: on Keep trying it may be ready.)
        return this.failed('being prepared', { retry: false, report: false, network: false, ruleOut: false })
      case 'busy':
        // The household's service is busy: its files of this type wait for its time; the others go on.
        this.trips.push({ type: 'busy', service: w.service, kind: w.kind, until: w.until })
        this.tried.delete(key)
        if (fromPlay && this.followed(this.current)) this.followedOpens--
        this.lookForMoreQuietly()
        return this.failed('busy', { retry: false, report: false, network: false })
      case 'refused':
        this.trips.push(w.why === 'limit' ? { type: 'sink', service: w.service }
          : w.why === 'plan' && w.kind ? { type: 'notInPlan', service: w.service, kind: w.kind }
            : { type: 'badKey', service: w.service })
        this.lookForMoreQuietly()
        return this.failed('refused', { retry: false, report: false, network: false })
      case 'offline':
        return this.giveUp(NO_CONNECTION)
    }
  }

  /**
   * The page's own look at the address before the video opens it (one byte asked, 8 s a call), as the TV's:
   * dead on a 404/410 (a followed link's asked afresh once instead, also on a 401/403); a host failing
   * twice (5xx) or not answering at all the next copy, now, not after 30 s of waiting. (A direct file's
   * free host or a usenet file being fetched may well be slow and still play: never skipped for that.)
   * Where the host doesn't let a page read its answer, only whether it answers at all. Not for live (HLS).
   */
  private checkThenOpen(url: string, direct: boolean, at: number, fromPlay: boolean, afresh: boolean) {
    const go = () => (fromPlay ? this.open(this.current, url, at) : this.playFile(this.current, at, url))
    if (/\.m3u8/i.test(url)) return go()
    // (Skipped for its silent host earlier, now opened anyway, without the look: the video's own 30 s.)
    if (this.openAnyway === this.keyAt(this.current)) { this.openAnyway = null; return go() }
    const attempt = this.opening
    const s = this.streams[this.current]
    // (A usenet file asked afresh would start a new download: never.)
    const canAskAfresh = !direct && !afresh && s.kind !== 'usenet' && this.followedOpens < MAX_FOLLOWED_OPENS
    void this.checkAddress(url, direct, attempt, direct || s.kind === 'usenet').then(check => {
      if (this.gone || attempt !== this.opening) return
      if (check === 'open') return go()
      // (A silent host: the next copy, and this one opened anyway once nothing else is left.)
      if (check === 'silent' && fromPlay) {
        this.silentSkipped.add(this.keyAt(this.current))
        return this.failed("its host isn't answering", { retry: false, report: false })
      }
      // (Its host isn't answering now: not dead, the next copy; it may be tried again later. Mid-film, one
      // of the reconnects: a short hiccup doesn't lose the file being watched.)
      // (Silent then too: still one to open anyway, with the video's 30 s, once the reconnects are spent and
      // nothing else is left; it was known to play.)
      if (check === 'silent') this.silentSkipped.add(this.keyAt(this.current))
      if (check === 'notNow' || check === 'silent') return this.failed("its host isn't answering", { retry: !fromPlay, report: false })
      if (check === 'afresh' && canAskAfresh) {
        this.followedOpens++
        const link = s.url + (s.url!.includes('?') ? '&' : '?') + 'fresh=1'
        return void this.whereItLeads(link, attempt).then(asked => {
          if (!this.gone && attempt === this.opening) this.whereCame(asked, at, fromPlay, true)
        })
      }
      // (A direct file's address gone: written down as seen gone, for the household.)
      if (check === 'dead' && s.key) this.host.sourceGone(this.videoId, s.addon, s.key)
      this.failed('its address is dead', { retry: false, report: false, network: check !== 'dead' })
    })
  }

  private async checkAddress(url: string, direct: boolean, attempt: number, slowIsNormal: boolean): Promise<Check> {
    for (let waited = false; attempt === this.opening && !this.gone;) {
      const r = await look(url, true, HOST_CHECK_MS)
      if (typeof r === 'string') {
        if (slowIsNormal) return 'open'
        // (Not let read, or perhaps a preflight never answered: whether the host answers a plain ask at all.)
        if (attempt !== this.opening || this.gone) return 'open'
        const plain = await look(url, false, r === 'silent' ? PLAIN_CHECK_MS : HOST_CHECK_MS)
        if (plain === 'silent') return 'silent'
        // (A followed link's host that can't be reached: asked afresh, as the TV does. Not an http address
        // on an https page, which the browser blocks itself.)
        const blocked = url.startsWith('http:') && location.protocol === 'https:'
        return plain === 'unreachable' && !direct && !blocked ? 'afresh' : 'open'
      }
      const code = r.status
      if (code === 404 || code === 410) return direct ? 'dead' : 'afresh'
      if (code === 401 || code === 403) return direct ? 'open' : 'afresh'
      // (A busy host, or the host itself failing: once more in a moment; then a busy one is opened anyway,
      // a failing one left for another copy.)
      if ((code === 429 || code >= 500) && !waited) waited = true
      else return code >= 500 ? 'notNow' : 'open'
      await sleep(Math.min(8_000, Math.max(1_000, r.retryAfter * 1000)))
    }
    return 'open'
  }

  /** New links for the same files (the server's token renewed, no new lookup): true once in. */
  private renewing: Promise<boolean> | null = null
  private renewLinks(): Promise<boolean> {
    // (One at a time: a second ask while one waits for the connection shares its answer.)
    return (this.renewing ??= this.renew().finally(() => { this.renewing = null }))
  }

  private async renew(): Promise<boolean> {
    const token = this.streams.map(s => s.url && TOKEN.exec(s.url)?.[1]).find(Boolean)
    if (!token) return false
    try {
      // (No connection yet, after a long pause say: waited for, a while, before giving up on renewing.)
      const begun = Date.now()
      let fresh: { token: string; linksExpireAt: number } | null = null
      while (!fresh) {
        try {
          fresh = await this.host.renewLinks(token, this.expectedMs)
        } catch (e) {
          if (!(e instanceof TypeError) || this.gone || Date.now() - begun > OFFLINE_WAIT_MS) throw e
          await sleep(5_000)
          if (this.gone) return false
        }
      }
      if (!fresh.token) return false
      const swap = (u: string) => u.replace(`/s/${token}/`, `/s/${fresh.token}/`)
      this.streams = this.streams.map(s => (s.url ? { ...s, url: swap(s.url) } : s))
      this.subtitles = this.subtitles.map(s => ({ ...s, url: swap(s.url) }))
      this.linksExpireAt = fresh.linksExpireAt
      if (this.play_) this.set({ play: { ...this.play_, streams: this.streams, subtitles: this.subtitles } })
      return true
    } catch {
      return false
    }
  }

  private lookAgainOnce(key: string, at: number) {
    if (this.lookedAgainFor === key) return this.failed('its link keeps expiring', { retry: false, network: false })
    this.lookedAgainFor = key
    this.lookAgain(at)
  }

  /** The links ran out and couldn't be renewed: a fresh play answer, on with the same source. */
  private lookAgain(at: number) {
    if (!this.streams[this.current]) return this.giveUp(COULDNT_PLAY)
    this.carryOn = { key: this.keyAt(this.current), at, beforeKey: this.before ? this.keyAt(this.before.index) : null }
    void this.load()
  }

  /** The same file again from [at], once the server says where its link leads now. From the second try it
   * asks the add-on afresh (fresh=1), but never for a usenet file. */
  private reconnect(at: number) {
    const s = this.streams[this.current]
    if (!s) return
    this.reconnects++
    this.showLoading()
    this.say(RECONNECTING)
    if (s.youtube || !this.asksFirst(s)) return this.playFile(this.current, at)
    // (The dropped one is stopped first: its late error doesn't use up the next tries.)
    clearTimeout(this.stalled)
    const attempt = ++this.opening
    this.set({ open: null })
    // (Asked afresh from the second try: the debrid link itself may have died. Never for usenet, where
    // asking again starts a new download.)
    const afresh = this.reconnects > 1 && s.kind !== 'usenet'
    const link = afresh ? s.url + (s.url!.includes('?') ? '&' : '?') + 'fresh=1' : s.url!
    this.whereItLeads(link, attempt).then(asked => {
      if (!this.gone && attempt === this.opening) this.whereCame(asked, at, false, afresh)
    })
  }

  // ---------- What the video says ----------

  /** The file's first picture is up: it plays. */
  startedPlaying(attempt: number, at = -1) {
    if (attempt !== this.opening || this.started) return
    this.started = true
    this.everStarted = true
    clearTimeout(this.stalled)
    clearTimeout(this.stillTimer)
    const s = this.streams[this.current]
    // A file this household saw gone lately, playing after all (for a little while): the server stops holding it back.
    if (s && (s.seen || s.dead) && s.key) {
      const key = s.key
      this.later(() => {
        if (attempt !== this.opening || !this.started || this.streams[this.current]?.key !== key) return
        this.streams = this.streams.map(x => (x.key === key ? { ...x, seen: false, dead: false } : x))
        this.host.sourcePlayed(this.videoId, key)
      }, KEEP_BEFORE_MS)
    }
    this.budgetEnd = Infinity
    this.renewedFor = null
    this.lookedAgainFor = null
    this.played.add(this.keyAt(this.current))
    if (this.tracks) this.pickedTrack = { key: this.keyAt(this.current), index: this.tracks.playing }
    this.checkAudio()
    // The source you picked works: after a little while, there's nothing to go back to.
    const b = this.before
    if (b) this.later(() => { if (this.before === b) this.before = null }, KEEP_BEFORE_MS)
    // (Picked up where this play began: said once, plainly.)
    if (!this.resumedSaid) {
      this.resumedSaid = true
      const where = at >= 0 ? at : this.resumeAt
      if (where > START_GRACE_MS && !this.wentBack && !this.startNote) this.note(`Resumed at ${clock(where)}`)
    }
    if (this.wentBack) { this.note(this.wentBack, BACK_NOTE_MS); this.wentBack = null }
    if (this.startNote) { this.note(this.startNote, BACK_NOTE_MS); this.startNote = null }
    this.set({ loading: false, line: null })
    // A good while playing well: its reconnects are behind it.
    this.later(() => { if (this.started && attempt === this.opening) { this.reconnects = 0; this.followedOpens = 0 } }, CLEAN_PLAY_MS)
  }

  /** Where the file playing is up to (ms). */
  time(attempt: number, ms: number) {
    if (attempt === this.opening && this.started) this.lastGood = ms
  }

  /** The file's length is known: one far too short is an error clip, not the video. */
  length(attempt: number, ms: number) {
    if (attempt === this.opening && this.notTheVideo(ms)) this.failed("wasn't the video", { retry: false, network: false })
  }

  /** The file ended at [at] of [len] ms: true when it really did (else it's dealt with here). */
  ended(attempt: number, at: number, len: number): boolean {
    if (attempt !== this.opening) return false
    if (this.notTheVideo(len, true)) { this.failed("wasn't the video", { retry: false, network: false }); return false }
    // The connection dropped well before the end: the same source again from where it was.
    if (len > 0 && at >= 0 && at < len - DROPPED_BEFORE_END_MS) { this.failed('dropped'); return false }
    return true
  }

  /** The video stopped with an error ([why]: for the server, never the viewer). */
  error(attempt: number, why: string, o: { retry?: boolean; network?: boolean } = {}) {
    if (attempt === this.opening && !this.gone) this.failed(why, o)
  }

  private notTheVideo(len: number, ended = false) {
    const tooShort = this.expectedMs > 0 ? this.expectedMs * SHORTEST_PART : MIN_UNKNOWN_LENGTH_MS
    return (len > 0 || ended) && (len < tooShort || (this.expectedMs <= 0 && len < this.resumeAt))
  }

  /** Where to carry on from: the last moment that played, in whichever file, or where tonight began. */
  resumeFrom = () => (this.lastGood >= 0 ? this.lastGood : this.resumeAt)

  // ---------- Failing ----------

  /**
   * A source failed. One that had been playing gets the same file again first, from where it was:
   * reconnect. Otherwise the next one; when none is left, more are looked for, then it gives up.
   * [retry] false: this file is wrong, never again. [network]: it may have been the connection's.
   */
  private failed(why: string, o: { retry?: boolean; report?: boolean; network?: boolean; ruleOut?: boolean } = {}) {
    const { retry = true, report = true, network = true, ruleOut = true } = o
    clearTimeout(this.stalled)
    this.openAnyway = null
    // (The note was about that copy.)
    this.startNote = null
    const key = this.keyAt(this.current)
    if (this.streams[this.current]) this.broke.add(key)
    // (A track switch under way ends with the file: its "Switching to…" goes now.)
    if (this.switching) { this.switching = false; clearTimeout(this.switchedAnyway); this.letGo() }
    // (A failure mid-film: 120 s from now to get going again.)
    if (this.budgetEnd === Infinity) this.budgetEnd = Date.now() + BUDGET_AFTER_MS
    // A language look under way while the film drops: called off.
    if (this.lookingFor) {
      const name = this.lookingFor
      this.lookingFor = null
      this.versionLook++
      this.letGo()
      this.note(this.notAvailableNow(name), BACK_NOTE_MS)
    }
    const at = this.resumeFrom()
    // The links for this answer have expired (a long pause, say): not this source's fault. Renewed, and on.
    // (Only for the video's own failures: an answer the server or the page's look just gave stands.)
    if (retry && report && this.linksExpireAt > 0 && Date.now() > this.linksExpireAt - LINKS_MARGIN_MS) {
      this.showLoading()
      this.say(this.everStarted ? RECONNECTING : GETTING_READY)
      const attempt = ++this.opening
      this.set({ open: null })
      return void this.renewLinks().then(ok => {
        if (this.gone || attempt !== this.opening) return
        if (ok) this.playFile(this.current, at); else this.lookAgain(at)
      })
    }
    if (retry && this.played.has(key) && this.reconnects < MAX_RECONNECTS) return this.reconnect(at)
    // A source you picked yourself didn't play: back to the one you were watching, where you were.
    const b = this.before
    if (b) {
      this.before = null
      this.wentBack = backLine(b)
      this.goneBack(b)
      this.showLoading()
      this.say(SWITCHING_BACK)
      return this.playFile(b.index, b.at)
    }
    // (One the server judged isn't the connection's: never put back. Ruled out only when it stays tried.)
    if (network) this.failedAt.set(key, Date.now())
    else if (ruleOut && this.tried.has(key)) this.ruledOut.add(key)
    const s = this.streams[this.current]
    if (report && s?.addon) this.host.sourceFailed(this.videoId, s.addon, why, s.filename)
    const next = this.nextToTry()
    if (next < 0) return this.moreOrGiveUp(at)
    // Out of time, with files left: plain words.
    if (Date.now() > this.budgetEnd) return this.giveUp(COULDNT_PLAY)
    // About to leave the wanted language: its busy or preparing file may be worth a wait first.
    const wait = this.wantWait(next)
    if (wait != null) return this.waitThen(wait)
    // Or, the wanted language only in files seen dead: the best of them, once.
    const dead = this.deadWantInstead(next)
    if (dead != null) { this.showLoading(); return this.playFile(dead, at) }
    // Few left of the ones that could play: more are asked for meanwhile.
    if (PlayOrder.mainLeft(this.orderFiles(), this.tried) <= FEW_LEFT) this.lookForMoreQuietly()
    this.showLoading()
    this.playFile(next, at)
  }

  private wantWait(next: number): number | null {
    const want = this.audioWant ?? this.profileAudio[0]
    if (!want || this.speaks(next, want)) return null
    const ms = PlayOrder.waitBeforeLeaving(this.orderFiles(), this.skip(), want, this.original(), Date.now(), this.budgetEnd, this.waitedForWant)
    if (ms == null) return null
    this.waitedForWant = true
    return ms
  }

  private deadWantInstead(next: number): number | null {
    if (this.triedDeadWant) return null
    const want = this.audioWant ?? this.profileAudio[0]
    if (!want || this.speaks(next, want)) return null
    const i = PlayOrder.deadWant(this.orderFiles(), this.skip(), want, this.original())
    if (i < 0) return null
    this.triedDeadWant = true
    return i
  }

  /** Waits [ms] on the loading screen ("Still getting it ready…"), then tries the next file. */
  private waitThen(ms: number) {
    // (The file that failed is stopped: should it open late, it isn't played and then cut off.)
    clearTimeout(this.stalled)
    this.showLoading()
    this.say(this.stillLine())
    const attempt = ++this.opening
    this.set({ open: null })
    this.later(() => {
      if (attempt !== this.opening) return
      const next = this.nextToTry()
      if (next >= 0) this.playFile(next, this.resumeFrom()); else this.outOfFiles()
    }, ms + WAIT_MARGIN_MS)
  }

  // ---------- More sources ----------

  /** Every source tried failed: if the server has more to ask, they're asked for and tried. Once per play. */
  private moreOrGiveUp(at: number) {
    if (this.more === 'none' || (this.more === 'offered' && this.askedMore)) return this.outOfFiles()
    this.askedMore = true
    this.showLoading()
    // (The same calm line: looking for more is the player's business, not the viewer's.)
    this.say(this.everStarted ? RECONNECTING : GETTING_READY)
    // (The file that failed stops: should it open late, it isn't played meanwhile and then cut off.)
    this.stopQuietly()
    this.lookForMore(() => {
      const next = this.nextToTry()
      if (next < 0) return this.outOfFiles()
      this.playFile(next, at)
    })
  }

  /** More sources asked for in the background (few left, the wanted language missing, Audio opened). Once. */
  lookForMoreQuietly(then: () => void = () => {}) {
    if (this.more !== 'offered' || this.askedMore) return
    this.askedMore = true
    this.lookForMore(() => then())
  }

  /** Asks the server for every source (once per play), and merges the answer into the list. */
  private lookForMore(then: (added: number) => void) {
    // (Already being asked: this waits for that answer too.)
    if (this.more === 'looking') { this.moreWaiters.push(then); return }
    if (this.more !== 'offered') return then(0)
    this.more = 'looking'
    this.moreWaiters.push(then)
    const asked = this.aheadMore ?? this.host.play(this.type, this.videoId, { binge: this.binge, audio: this.pickState ?? '*', more: true })
    this.aheadMore = null
    asked.then(p => this.moreCame(p), () => this.moreCame(null))
  }

  /** Every source arrived (or null): merged without stopping what's playing; whoever waited is told. */
  private moreCame(p: Play | null) {
    if (this.gone) return
    const done = (added: number) => {
      const waiters = this.moreWaiters
      this.moreWaiters = []
      waiters.forEach(w => w(added))
      // (The wanted language may have come with them.)
      this.checkAudio()
    }
    if (!p) { this.more = 'offered'; return done(0) }
    this.more = 'none'
    const fresh = p.streams
    const added = fresh.length - this.streams.length
    if (added <= 0) return done(0)
    const want = this.audioWant
    const wantBefore = want ? this.hasWant(want) : null
    // The same source in the new list: by add-on and file name (and which of several alike).
    const old = this.streams
    const freshKeys = keysOf(fresh)
    const place = (i: number) => (i >= 0 && old[i] ? freshKeys.indexOf(this.keyAt(i)) : -1)
    const now = place(this.current)
    const b = this.before
    const back = b ? (() => { const i = place(b.index); return i >= 0 ? { ...b, index: i } : null })() : null
    // (Should the one playing not be there, it's kept, last, so nothing changes under it.)
    if (now >= 0 || this.current < 0) { this.streams = fresh; this.current = now }
    else { this.streams = [...fresh, old[this.current]]; this.current = this.streams.length - 1 }
    this.keys = keysOf(this.streams)
    this.before = back
    if (p.linksExpireAt) this.linksExpireAt = this.linksExpireAt > 0 ? Math.min(this.linksExpireAt, p.linksExpireAt) : p.linksExpireAt
    if (this.play_) this.set({ play: { ...this.play_, streams: this.streams } })
    // The wanted language came with them while another plays: it's in Audio now, and said so (once).
    if (want && this.started && wantBefore === false && this.hasWant(want) && this.heardCode() !== want) this.sayAvailable(want)
    done(added)
  }

  // ---------- Nothing left ----------

  private nothingToPlay() {
    // (The server has more to ask: those first, before saying there's nothing.)
    if (this.more === 'offered' && !this.askedMore) return this.moreOrGiveUp(this.resumeAt)
    this.outOfFiles()
  }

  private outOfFiles() {
    // (Every source still being asked for: its answer first.)
    if (this.more === 'looking') {
      this.stopQuietly()
      return this.lookForMore(() => { const n = this.nextToTry(); if (n >= 0) this.playFile(n, this.resumeFrom()); else this.outOfFiles() })
    }
    // Only files named as other episodes: asked whether to play one anyway; once said yes, the next in turn.
    const other = this.otherEpisodeLeft()
    if (other != null) {
      if (this.otherOk) return this.playFile(other, this.resumeFrom())
      if (!this.otherAsked && !this.everStarted) return this.askOtherEpisode()
    }
    if (!this.streams.length || this.streams.every(s => suspect(s))) return this.giveUp(this.notice ?? NOTHING_YET)
    // (Web: nothing here a browser can play.)
    if (!this.streams.some(s => !suspect(s) && this.browserOk(s))) return this.giveUp(this.host.nothingPlaysHere)
    // Only busy or being-prepared files left: their time waited for, when it fits in what's left.
    const soon = PlayOrder.soonest(this.orderFiles(), this.skip())
    if (soon != null) {
      const now = Date.now()
      if (Math.max(soon, now) + PlayOrder.TRY_MS <= this.budgetEnd) return this.waitThen(soon - now)
    }
    // The best file skipped for its silent host, now that nothing else is left: opened without the look,
    // with the video's 30 s (some hosts are just slow to start). One a round, while time is left.
    const silent = this.silentToOpen()
    if (silent != null) {
      this.silentSkipped.clear()
      this.openAnyway = silent
      this.showLoading()
      return this.playFile(this.keys.indexOf(silent), this.resumeFrom())
    }
    // Ended by a cap (the debrid calls, the time) while files that could play are left: plain words.
    if (this.nextToTry(null, false) >= 0) return this.giveUp(COULDNT_PLAY)
    // The file whose download was started last time still isn't ready: still being prepared (no other
    // download is started for it).
    if (this.preparing && this.tried.has(this.preparing)) {
      preparingStarted.set(this.videoId, { key: this.preparing, at: Date.now() })
      return this.giveUp(BEING_PREPARED)
    }
    const ending = PlayOrder.ending(this.orderFiles(), this.tried)
    if (ending === 'account') return this.giveUp(ACCOUNT_PROBLEM)
    if (ending === 'busy') return this.giveUp(TOO_MANY_REQUESTS)
    if (this.preparedOnce || ending !== 'prepare') return this.giveUp(COULDNT_PLAY)
    // Not-downloaded files left: one is started (its link asked once starts the download), and said so.
    this.preparedOnce = true
    const order = this.orderFiles()
    const waiting = this.streams.findIndex((s, i) => s.cached === false && !suspect(s) && !!s.url && this.browserOk(s) &&
      !order[i].skipped && !this.tried.has(this.keyAt(i)))
    if (waiting < 0) return this.giveUp(COULDNT_PLAY)
    this.showLoading()
    this.say(this.everStarted ? RECONNECTING : GETTING_READY)
    const attempt = ++this.opening
    this.set({ open: null })
    const key = this.keyAt(waiting)
    this.whereItLeads(this.streams[waiting].url!, attempt).then(asked => {
      if (this.gone || attempt !== this.opening) return
      // (The list may have changed meanwhile: the same file, by its key.)
      const now = this.keys.indexOf(key)
      if (now >= 0 && asked.where.t === 'at') return this.playFile(now, this.resumeFrom(), asked.where.url)
      preparingStarted.set(this.videoId, { key, at: Date.now() })
      this.giveUp(BEING_PREPARED)
    })
  }

  /** Files skipped this round because their host sent nothing in 8 s; opened anyway once nothing else is
   * left ([openAnyway]: the one being opened so, without the look). */
  private silentSkipped = new Set<string>()
  private openAnyway: string | null = null

  /** The best file skipped for its silent host this round, if it's still here and there's time for it. */
  private silentToOpen(): string | null {
    const key = [...this.silentSkipped].find(k => !this.ruledOut.has(k) && this.keys.indexOf(k) >= 0)
    return key != null && Date.now() + START_TIMEOUT_MS <= this.budgetEnd ? key : null
  }

  private otherEpisodeLeft(): number | null {
    // (The right episode's file skipped for its silent host goes first.)
    const silent = this.silentToOpen()
    if (silent != null && !suspect(this.streams[this.keys.indexOf(silent)])) return null
    if (this.streams.some(s => !suspect(s)) && this.nextToTry(null, false) >= 0) return null
    if (this.streams.some((s, i) => !suspect(s) && !this.tried.has(this.keyAt(i)) && this.browserOk(s))) return null
    const i = this.streams.findIndex((s, i) => !!s.otherEpisode && s.cached !== false && (!!s.youtube || !!s.url) &&
      this.browserOk(s) && !this.tried.has(this.keyAt(i)))
    return i >= 0 ? i : null
  }

  private askOtherEpisode() {
    this.otherAsked = true
    this.stopForCard()
    this.set({ card: 'otherEpisodes' })
  }

  /** "Play one anyway?" answered Play. */
  playOtherEpisodes() {
    this.otherOk = true
    this.set({ card: null })
    this.showLoading()
    this.say(GETTING_READY)
    this.outOfFiles()
  }

  private giveUp(message: string) {
    this.openAnyway = null
    // Nothing played this time: asked whether to keep trying.
    if (message === COULDNT_PLAY && this.canKeepTrying()) return this.askKeepTrying()
    this.end(message)
  }

  private end(message: string) {
    this.opening++
    clearTimeout(this.stalled)
    clearTimeout(this.stillTimer)
    this.set({ open: null, loading: true, line: null, card: null, ended: message })
  }

  private canKeepTrying() {
    return (this.more === 'offered' && !this.askedMore) ||
      PlayOrder.next(this.orderFiles(), new Set([...this.ruledOut, ...this.rejected]), {
        want: this.audioWant, quality: this.qualityWant, original: this.original(),
        now: Date.now() + BUDGET_AFTER_MS - PlayOrder.TRY_MS,
      }) >= 0
  }

  /** What was opening stops (nothing plays behind a wait), the screen as it is. */
  private stopQuietly() {
    this.opening++
    clearTimeout(this.stalled)
    this.set({ open: null })
  }

  /** Nothing plays, or is tried, behind a card. */
  private stopForCard() {
    this.opening++
    clearTimeout(this.stalled)
    clearTimeout(this.stillTimer)
    this.set({ open: null, loading: true, line: null })
  }

  private askKeepTrying() {
    this.stopForCard()
    this.set({ card: 'keepTrying' })
  }

  /** Another go: 2 more minutes; the files found gone, refused, or left by the viewer stay out. */
  keepTrying() {
    this.set({ card: null })
    this.budgetEnd = Date.now() + BUDGET_AFTER_MS
    this.tried = new Set([...this.ruledOut, ...this.rejected].filter(k => this.tried.has(k)))
    this.silentSkipped.clear()
    this.openAnyway = null
    this.failedAt.clear()
    this.followedOpens = 0
    this.reconnects = 0
    this.waitedForWant = false
    this.showLoading()
    this.say(this.everStarted ? RECONNECTING : GETTING_READY)
    const next = this.nextToTry()
    if (next >= 0) this.playFile(next, this.resumeFrom()); else this.moreOrGiveUp(this.resumeFrom())
  }

  // ---------- The loading screen ----------

  private showLoading() {
    this.set({ loading: true, ended: null })
  }

  /** The loading screen's one line, breathing while it waits; "Still getting it ready…" after a while. */
  private say(line: string) {
    // (A minute in with nothing played yet: it stays "Almost there…".)
    this.set({ line: line === GETTING_READY && this.stillLine() === ALMOST_THERE ? ALMOST_THERE : line })
    clearTimeout(this.stillTimer)
    if (line === GETTING_READY) this.stillTimer = setTimeout(() => { if (!this.started && !this.gone) this.set({ line: this.stillLine() }) }, STILL_AFTER_MS)
  }

  private stillLine() {
    return !this.everStarted && Date.now() - this.openedAt > ALMOST_AFTER_MS ? ALMOST_THERE : STILL_GETTING_READY
  }

  note(text: string, ms = NOTE_MS) {
    this.set({ note: { text, n: ++this.noteN, ms }, held: null })
  }
  private hold(text: string) { this.set({ held: text }) }
  private letGo() { if (this.view.held) this.set({ held: null }) }

  // ---------- Audio ----------

  /** The page says which audio tracks the file playing has and which plays (null: it can't tell). */
  setTracks(attempt: number, tracks: Tracks) {
    if (attempt !== this.opening) return
    this.tracks = tracks
    // (Only once it plays: what's playing then is the track to come back to.)
    if (tracks && this.started) this.pickedTrack = { key: this.keyAt(this.current), index: tracks.playing }
    if (this.started) this.checkAudio()
  }

  /** "Hindi isn't available right now. Still in English." (the second part when another is heard). */
  private notAvailableNow(name: string) {
    const code = this.heardCode()
    const now = code ? SPOKEN[code] ?? null : null
    return `${name} isn't available right now.${now && now !== name ? ` Still in ${now}.` : ''}`
  }

  /** The language heard now, as a code, or null when it can't be told. */
  heardCode(): string | null {
    if (this.tracks) return this.tracks.languages[this.tracks.playing] ?? null
    const s = this.streams[this.current]
    if (!s) return null
    // (Played as it is, a browser plays the first track: its header's, else the one its name says when it names one.)
    if (s.fileAudio?.length) return s.fileAudio[0] === 'und' ? null : s.fileAudio[0]
    return s.languages?.length === 1 ? s.languages[0] : null
  }

  /** The file's own languages, as far as they're known (null: not known). */
  private hereCodes(): (string | null)[] | null {
    if (this.tracks) return this.tracks.languages
    // (Not read here yet: with the smart way it may switch to any of them once it is; otherwise the browser
    // plays its first track.)
    const s = this.streams[this.current]
    if (!s) return null
    const langs = this.fileLangs(s)
    return langs.length ? langs : null
  }

  /** The audio languages other files the player could switch to now name (Audio lists them). */
  languagesElsewhere(except: Set<string> = new Set()): string[] {
    const out: string[] = []
    for (const i of this.switchable(except)) for (const l of this.fileLangs(this.streams[i])) if (l !== 'und' && !out.includes(l)) out.push(l)
    return out
  }

  /** The other files the player could switch to now: not another's, downloaded, playable here, not failed
   * or left this play, not refused by their account, busy or being prepared. (Audio's list and a language
   * pick go by the same set.) */
  private switchable(except: Set<string> = new Set()): number[] {
    const order = this.orderFiles()
    const now = Date.now()
    return this.streams.map((_, i) => i).filter(i => {
      const s = this.streams[i], k = this.keyAt(i), f = order[i]
      if (i === this.current || suspect(s) || s.cached === false || s.youtube || !s.url || !this.browserOk(s)) return false
      if ((this.tried.has(k) && !this.played.has(k)) || this.ruledOut.has(k) || this.rejected.has(k) || except.has(k)) return false
      return !f.skipped && (f.busyUntil ?? 0) <= now && (f.preparingUntil ?? 0) <= now
    })
  }

  /** Whether Audio lists [want] from another file (not from one that broke this play, even after it played). */
  private hasWant = (want: string) => !!SPOKEN[want] && this.languagesElsewhere(this.broke).includes(want)

  private sayAvailable(want: string) {
    if (this.availableSaid) return
    this.availableSaid = true
    this.wantMissing = null
    this.note(`${languageName(want)} audio is available now`, BACK_NOTE_MS)
  }

  /**
   * Once a file plays: the language picked, now heard, holds (kept for the show); a picked language this
   * file hasn't: back to the one before a pick, more sources asked, "available now", or said once a binge.
   */
  private checkAudio() {
    if (!this.started) return
    const picked = this.audioWant
    if (!picked) return
    const heard = this.heardCode()
    if (heard === picked) {
      // (A track just switched to isn't heard yet: once playback is past the switch, switched() looks again.)
      if (this.switching) return
      // A version switched to for a language, now heard in it: the pick holds (kept for the show).
      if (this.pendingPick === picked) { this.pendingPick = null; this.picked(picked) }
      if (this.pickToSave != null) this.pickHeard = true
      return
    }
    // A version switched to for a language whose tracks don't say theirs (found as a maybe): once it plays
    // and its tracks were read (not before: they may yet show it hasn't), the pick holds as one heard (it
    // can't be told otherwise), so it's kept and carried.
    if (heard == null && this.tracks && this.pendingPick === picked && !this.switching) {
      this.pendingPick = null
      this.picked(picked)
      if (this.pickToSave != null) this.pickHeard = true
      return
    }
    // (A track that says nothing of its language may be it: only when each says, is it known not there.)
    const here = this.hereCodes()
    if (!here || here.includes(picked) || here.some(l => l == null || l === 'und')) return
    const name = languageName(picked)
    const b = this.before
    if (b) {
      this.before = null
      this.goneBack(b)
      this.showLoading()
      this.say(SWITCHING_BACK)
      this.wentBack = backLine(b)
      this.playFile(b.index, this.resumeFrom())
    } else if (this.more === 'offered' && !this.askedMore && this.wantMissing !== picked) {
      // (More sources may have it: asked first; this is looked at again when they're in.)
      this.lookForMoreQuietly(() => {
        if (this.more === 'none' && !this.streams.some((_, i) => this.speaks(i, picked))) this.wantMissing = picked
      })
    } else if (this.availableSaid) {
      // (Already said it's in Audio now.)
    } else if (this.more !== 'looking' && this.hasWant(picked)) {
      this.sayAvailable(picked)
    } else if (this.more !== 'looking' && !this.lineSaid) {
      // Said once in a binge. A file in it that was there but couldn't play now: "right now".
      this.lineSaid = true
      const there = this.streams.some((s, i) => this.speaks(i, picked) && !suspect(s))
      this.note(there ? this.notAvailableNow(name) : `${name} isn't available for this episode`, BACK_NOTE_MS)
    }
  }

  /** The viewer picked [code] in Audio: wanted from now on, through the binge, and kept for the show. */
  private picked(code: string) {
    this.audioWant = code
    // (A language now: no longer a track by its number.)
    this.carriedTrack = null
    this.pickState = code === this.profileAudio[0] ? '' : code
    this.pickToSave = this.pickState
    this.pickHeard = false
    this.lineSaid = false
  }

  private goneBack(b: Before) {
    // (A pick that didn't hold isn't sent.)
    this.pickHeard = false
    this.audioWant = b.want
    this.qualityWant = b.qualityWant
    this.pendingPick = null
  }

  /** A new pick: any language look under way is called off, and its "Switching to…" note goes. */
  private cancelPick() {
    this.versionLook++
    if (this.lookingFor) { this.lookingFor = null; this.letGo() }
  }

  /** What Audio lists: this file's languages (by track, when the page can switch tracks), then those only
   * other versions have. */
  audioChoices(): { here: { code: string | null; track: number; on: boolean }[]; elsewhere: string[] } {
    this.lookForMoreQuietly()
    const tracks = this.tracks
    const here: { code: string | null; track: number; on: boolean }[] = []
    if (tracks) {
      // One row per language: its first track, a commentary only when there's no other; each track that
      // doesn't say, by its number (as the Android TV does).
      const seen = new Set<string>()
      const order = tracks.languages.map((_, i) => i).sort((a, b) => Number(commentary(tracks.names?.[a])) - Number(commentary(tracks.names?.[b])) || a - b)
      for (const i of order) {
        const code = tracks.languages[i]
        if (i !== tracks.playing && tracks.switchable && !tracks.switchable[i]) continue
        const id = code ?? `#${i}`
        if (seen.has(id)) continue
        seen.add(id)
        here.push({ code, track: i, on: i === tracks.playing || (code != null && code === tracks.languages[tracks.playing]) })
      }
      here.sort((a, b) => a.track - b.track)
    } else {
      const heard = this.heardCode()
      if (heard) here.push({ code: heard, track: 0, on: true })
    }
    const hereCodes = here.map(h => h.code)
    const elsewhere = this.languagesElsewhere().filter(c => !hereCodes.includes(c) && !!SPOKEN[c])
    return { here, elsewhere }
  }

  /** A track of this file picked in Audio ([code]: its language, if it says): [switchTrack] switches it. */
  pickTrack(code: string | null, on: boolean, track: number, switchTrack: () => boolean, seekable = true) {
    this.cancelPick()
    if (on) {
      // The one playing, picked while another is wanted: this one is wanted now, and kept for the show.
      if (code && this.audioWant && code !== this.audioWant) { this.picked(code); this.checkAudio() }
      return
    }
    const name = code ? languageName(code) : `Audio ${track + 1}`
    // Where the file can't seek (it can't drop what's buffered in the old one): switched, and said.
    if (!seekable) {
      if (!switchTrack()) return this.note(`Couldn't switch to ${name} right now`)
      if (code) this.picked(code)
      this.pickedTrack = { key: this.keyAt(this.current), index: track }
      const group = this.streams[this.current]?.bingeGroup
      this.carriedTrack = code == null && group ? `${group}|${track}` : null
      return this.note(`Audio: ${name}`)
    }
    // (Switching from here: not heard until playback is past it.)
    this.switching = true
    this.hold(`Switching to ${name}…`)
    if (!switchTrack()) {
      this.switching = false
      this.letGo()
      return this.note(`Couldn't switch to ${name} right now`)
    }
    if (code) this.picked(code)
    this.pickedTrack = { key: this.keyAt(this.current), index: track }
    // (A track that doesn't say its language goes on, by its number, in the same release.)
    const group = this.streams[this.current]?.bingeGroup
    this.carriedTrack = code == null && group ? `${group}|${track}` : null
    clearTimeout(this.switchedAnyway)
    this.switchedAnyway = this.later(() => this.switched(), SWITCH_MOST_MS)
  }

  /** The file's wanted language turned out to be another of its tracks (read late): switched to, as the TV
   * puts it right once its tracks are listed ("Switching to Hindi…" until heard). */
  switchTo_(code: string, switchTrack: () => boolean) {
    this.switching = true
    this.hold(`Switching to ${languageName(code)}…`)
    if (!switchTrack()) { this.switching = false; this.letGo(); return }
    clearTimeout(this.switchedAnyway)
    this.switchedAnyway = this.later(() => this.switched(), SWITCH_MOST_MS)
  }

  /** The audio track switched to is heard now (playback moved on), or it's been long enough. */
  switched() {
    if (!this.switching) return
    this.switching = false
    clearTimeout(this.switchedAnyway)
    this.letGo()
    this.checkAudio()
  }

  /** A language only other versions list: the server reads the best few's own track lists, and the first
   * that has it is switched to, from the same moment; if it won't play or hasn't it after all, back. */
  findVersion(code: string) {
    const name = languageName(code)
    const files = this.orderFiles()
    const original = this.original()
    const all = this.switchable()
      .filter(i => PlayOrder.speaks(files[i], code, original))
      .sort((a, b) => (PlayOrder.level(files[a], code, original) - PlayOrder.level(files[b], code, original)) ||
        ((this.streams[a].verified === false ? 1 : 0) - (this.streams[b].verified === false ? 1 : 0)) || a - b)
    this.cancelPick()
    if (!all.length) return this.note(`${name} isn't available for this one`, BACK_NOTE_MS)
    const look = this.versionLook
    // Its own header already says so: switched to at once.
    if (PlayOrder.level(files[all[0]], code, original) === 0) {
      this.pendingPick = code
      return this.switchTo(all[0], `Switching to ${name}…`, { want: code, language: name })
    }
    const candidates = all.slice(0, VERSIONS_CHECKED).map(i => ({ key: this.keyAt(i), s: this.streams[i] }))
    this.lookingFor = name
    this.hold(`Switching to ${name}…`)
    this.host.audioLanguages(candidates.map(c => c.s.url!)).then(r => r.languages, () => null).then(found => {
      if (this.gone || look !== this.versionLook) return
      this.lookingFor = null
      if (!found) { this.letGo(); return this.note(this.notAvailableNow(name), BACK_NOTE_MS) }
      // (Without the smart way, only a file whose first track it is plays it.)
      const has = candidates.findIndex((c, k) => (this.smartPossible(c.s) ? found[k]?.includes(code) : found[k]?.[0] === code))
      // (A track that doesn't say may be it, in a file named for it; one naming none only when its header was read.)
      const maybe = candidates.findIndex((c, k) => {
        const named = (c.s.languages ?? []).includes(code)
        return named ? found[k] == null || found[k]!.includes('und') : JSON.stringify(found[k]) === '["und"]'
      })
      const pick = has >= 0 ? has : maybe
      if (pick < 0) { this.letGo(); return this.note(`${name} isn't available for this one`, BACK_NOTE_MS) }
      const index = this.keys.indexOf(candidates[pick].key)
      if (index < 0) { this.letGo(); return this.note(this.notAvailableNow(name), BACK_NOTE_MS) }
      this.pendingPick = code
      const read = found[pick]
      if (read) this.streams = this.streams.map((s, i) => (i === index ? { ...s, fileAudio: read } : s))
      this.letGo()
      this.switchTo(index, `Switching to ${name}…`, { want: code, language: name })
    })
  }

  /** Plays source [i] from where this one is, saying [status] while it opens. */
  private switchTo(i: number, status: string, o: { want?: string | null; language?: string | null; quality?: string | null
    previousQuality?: string | null; canGoBack?: boolean } = {}) {
    const { want = this.audioWant, language = null, quality = null, previousQuality = this.qualityWant, canGoBack = true } = o
    const at = this.resumeFrom()
    if (!canGoBack) this.before = null
    if (this.started && canGoBack) {
      const heard = this.heardCode()
      const res = this.streams[this.current]?.resolution
      this.before = { index: this.current, at, want: this.audioWant, language, heard: heard ? SPOKEN[heard] ?? null : null,
        quality, wasQuality: res ? QUALITY_NAMES[res] ?? null : null, qualityWant: previousQuality }
    }
    this.audioWant = want
    this.showLoading()
    this.say(status)
    // (A picked version gets less time to start: if it doesn't, straight back to the one before.)
    this.playFile(i, at, undefined, this.started || this.before ? PICK_START_TIMEOUT_MS : START_TIMEOUT_MS)
  }

  /** Which audio track to open the file being opened in, when it's known: the one that was playing in this
   * very file (a reconnect), else a carried track of the same release; else null (by language). */
  trackToOpen(): number | null {
    const k = this.keyAt(this.current)
    if (this.pickedTrack?.key === k) return this.pickedTrack.index
    const group = this.streams[this.current]?.bingeGroup
    if (this.carriedTrack && group && this.carriedTrack.slice(0, this.carriedTrack.lastIndexOf('|')) === group) {
      const n = Number(this.carriedTrack.slice(this.carriedTrack.lastIndexOf('|') + 1))
      if (Number.isInteger(n)) return n
    }
    return null
  }

  /**
   * The track the file being opened should play, once the app has its tracks' languages ([languages],
   * in the file's order), as the Android TV picks it: the one that was playing in this very file,
   * a carried track of the same release, the wanted language's place in the server's reading of the
   * header (where the app allows it and the counts agree), then by language: the wanted one, the
   * profile's, the title's own. Null: the file's own default.
   */
  openTrack(languages: (string | null)[], names: (string | null)[] = []): number | null {
    const known = this.trackToOpen()
    if (known != null && known >= 0 && known < languages.length) return known
    const want = [this.audioWant, ...this.profileAudio].filter((x, i, all): x is string => !!x && all.indexOf(x) === i)
    if (!want.length) return null
    const header = this.streams[this.current]?.fileAudio
    if (this.host.headerIndexes && header && header.length === languages.length) {
      const at = header.indexOf(want[0])
      if (at >= 0) return at
    }
    for (const w of want) {
      const at = languages.findIndex((l, i) => l === w && !commentary(names[i]))
      if (at >= 0) return at
    }
    return null
  }

  /**
   * Once the file's tracks are listed: the track to switch to where the one playing isn't the wanted
   * language but another, by its name, is (as the Android TV does). Not when the file was opened in
   * a track by number (picked here, or the server's header lists the language), never by a guess. Null:
   * nothing to put right. Asked with the tracks just listed, before setTracks records them (Android
   * puts it right first, then keeps what plays).
   */
  lateCorrection(t: NonNullable<Tracks>): number | null {
    const want = this.audioWant ?? this.profileAudio[0] ?? null
    if (!want) return null
    const s = this.streams[this.current]
    // (Opened by the header's place only where the app opens files so.)
    const byNumber = this.pickedTrack?.key === this.keyAt(this.current) || (this.host.headerIndexes && !!s?.fileAudio?.includes(want))
    if (byNumber || t.languages[t.playing] === want) return null
    const better = t.languages.findIndex((l, i) => l === want && !commentary(t.names?.[i]))
    return better >= 0 ? better : null
  }

  // ---------- Quality ----------

  private languageNow = () => this.audioWant ?? this.heardCode() ?? this.profileAudio[0] ?? null

  /** What Quality lists: Auto (with what's playing), each quality there's a file of in the language playing,
   * and whether "Try another version" is there. */
  qualityChoices(): { auto: string | null; qualities: string[]; another: boolean } {
    const lang = this.languageNow()
    const failedHere = this.failedHere()
    const usable = this.streams.map((_, i) => i).filter(i => {
      const s = this.streams[i]
      return !suspect(s) && s.cached !== false && (!!s.youtube || !!s.url) && this.browserOk(s) && !failedHere.has(this.keyAt(i))
    })
    const speakers = usable.filter(i => this.speaks(i, lang))
    const inLang = speakers.length ? speakers : usable
    const res = this.streams[this.current]?.resolution
    const qualities = QUALITIES.filter(q => inLang.some(i => this.streams[i].resolution === q) || res === q)
    return { auto: res ? QUALITY_NAMES[res] ?? null : null, qualities, another: usable.length > 0 || this.nearMiss().length > 0 }
  }

  private failedHere() {
    const out = new Set([...this.tried].filter(k => !this.played.has(k)))
    for (const k of this.rejected) out.add(k)
    out.add(this.keyAt(this.current))
    return out
  }

  /** Copies that run far from the title's length (may be cut, or another episode): after the good ones. */
  private nearMiss() {
    const order = this.orderFiles()
    const now = Date.now()
    const failedHere = this.failedHere()
    return this.streams.map((_, i) => i).filter(i => {
      const s = this.streams[i], f = order[i]
      return !!s.otherLength && !s.otherEpisode && s.cached !== false && (!!s.youtube || !!s.url) && this.browserOk(s) &&
        !failedHere.has(this.keyAt(i)) && !f.skipped && (f.busyUntil ?? 0) <= now && (f.preparingUntil ?? 0) <= now
    })
  }

  /** Auto picked in Quality. */
  pickAuto() { this.cancelPick(); this.qualityWant = null }

  /** A quality picked: the best file of it in the language playing, from the same moment. */
  pickQuality(q: string) {
    if (this.qualityWant === q) return
    this.cancelPick()
    const previous = this.qualityWant
    const name = QUALITY_NAMES[q] ?? q
    this.qualityWant = q
    if (this.streams[this.current]?.resolution === q) return
    const lang = this.languageNow()
    const failedHere = this.failedHere()
    const speakers = this.streams.map((_, i) => i).filter(i => !failedHere.has(this.keyAt(i)) && this.speaks(i, lang))
    const langKnown = speakers.length > 0
    // (Only files of that quality, in the language playing when there are any: a quality pick never quietly changes the language.)
    const other = this.streams.map((_, i) => i).filter(i => this.streams[i].resolution !== q || (langKnown && !this.speaks(i, lang))).map(this.keyAt)
    const pick = PlayOrder.next(this.orderFiles(), new Set([...failedHere, ...other]), { want: lang, quality: q, original: this.original() })
    if (pick < 0) { this.qualityWant = previous; return this.note(`${name} isn't available for this one`, BACK_NOTE_MS) }
    this.switchTo(pick, `Switching to ${name}…`, { quality: name, previousQuality: previous })
  }

  /** "Try another version": the next copy in the same language and quality, from the same moment; this one
   * isn't tried again in this play, and there's no going back to it. */
  tryAnother() {
    this.cancelPick()
    const lang = this.languageNow()
    const here = this.streams[this.current]?.resolution || null
    const good = PlayOrder.next(this.orderFiles(), this.failedHere(), { want: lang, quality: here, original: this.original() })
    let pick = good
    if (pick < 0) {
      const near = this.nearMiss().sort((a, b) => ((this.speaks(a, lang) ? 0 : 1) - (this.speaks(b, lang) ? 0 : 1)) ||
        ((this.streams[a].resolution === here ? 0 : 1) - (this.streams[b].resolution === here ? 0 : 1)) || a - b)
      pick = near[0] ?? -1
    }
    if (pick < 0) return this.note("There isn't another version of this one", BACK_NOTE_MS)
    this.rejected.add(this.keyAt(this.current))
    this.startNote = good < 0 ? MAY_NOT_BE_RIGHT : null
    this.switchTo(pick, SWITCHING, { canGoBack: false })
  }

  // ---------- Subtitles ----------

  /** The profile's own subtitle language ("eng", "off"), once read. */
  setProfileSubs(code: string | null) { this.profileSubs = code }

  /** The subtitles wanted: picked for this show (here or before), else the profile's. */
  subsWant = () => this.subsPick ?? this.profileSubs ?? 'off'

  /** Subtitles picked in the player: for this show (and its next episodes), sent with the next save. */
  pickSubtitles(code: string) {
    // (One bad code never stops a save: picks are checked loosely, and a code the server won't take isn't sent.)
    const clean = code.toLowerCase()
    this.subsPick = clean
    if (/^(off|[a-z]{2,3}(-[a-z0-9]{2,4})?)$/.test(clean)) this.subsToSave = clean
  }

  // ---------- Saving ----------

  /** The picks to send with a save (the audio one only once heard), until a save goes through. */
  picksToSend(): { audioPick?: string; subtitlePick?: string } {
    return {
      ...(this.pickToSave != null && this.pickHeard ? { audioPick: this.pickToSave } : {}),
      ...(this.subsToSave != null ? { subtitlePick: this.subsToSave } : {}),
    }
  }

  /** A pick waiting to be sent (then a save goes out even while paused). */
  pickWaiting = () => this.subsToSave != null || (this.pickToSave != null && this.pickHeard)

  /** A save carrying these picks went through: they're kept now. */
  saved(sent: { audioPick?: string; subtitlePick?: string }) {
    if (sent.audioPick != null && this.pickToSave === sent.audioPick) this.pickToSave = null
    if (sent.subtitlePick != null && this.subsToSave === sent.subtitlePick) this.subsToSave = null
  }

  /** What the next episode starts with. */
  carry(): Carry {
    return {
      ...(this.pickState != null ? { pick: this.pickState } : {}),
      ...(this.qualityWant ? { quality: this.qualityWant } : {}),
      ...(this.wantMissing ? { wantMissing: this.wantMissing } : {}),
      ...(this.lineSaid ? { lineSaid: true } : {}),
      ...(this.subsPick ? { subs: this.subsPick } : {}),
      ...(this.carriedTrack ? { track: this.carriedTrack } : {}),
    }
  }

  // ---------- The next episode, ahead ----------

  /** In this episode's last minutes: the next one's play answer asked for (once), with every source too when
   * it hasn't the picked language and the server has more; the next episode takes them. */
  prefetchNext(nextId: string) {
    const binge = this.streams[this.current]?.bingeGroup ?? null
    const path = aheadPath('series', nextId, binge, this.pickState, this.host.profileKey())
    // (Once per path, however it went: the TV asks once an episode.)
    if (this.prefetched === path || ahead?.path === path) return
    this.prefetched = path
    const answer = this.host.play('series', nextId, { binge, audio: this.pickState ?? '*' })
    const entry: NonNullable<typeof ahead> = { path, at: Date.now(), answer }
    ahead = entry
    answer.catch(() => { if (ahead === entry) ahead = null })
    const want = this.audioWant
    answer.then(p => {
      const missing = want != null && this.wantMissing !== want && p.moreSources &&
        !p.streams.some(x => PlayOrder.speaks({ key: '', verified: x.verified !== false, languages: x.fileAudio ?? x.languages ?? [] }, want, p.originalLanguage))
      if (missing && ahead === entry) {
        entry.more = this.host.play('series', nextId, { binge, audio: this.pickState ?? '*', more: true })
        entry.more.catch(() => {})
      }
    }, () => {})
  }

  // ---------- For the page ----------

  stream = (i = this.current) => this.streams[i]
  isStarted = () => this.started
  /** A track switch under way ("Switching to Hindi…" until heard). */
  isSwitching = () => this.switching

  /** Back while switching to a version you picked: back on the one you were watching, where you were
   * (true), as the TV's Back before the picture. False: nothing to go back to. */
  cancelSwitch(): boolean {
    const b = this.before
    if (this.started || !b) return false
    this.before = null
    this.wentBack = null
    this.goneBack(b)
    this.showLoading()
    this.say(SWITCHING_BACK)
    this.playFile(b.index, b.at)
    return true
  }

  /** New links now (the page's subtitles expired): true once in. */
  freshLinks = () => this.renewLinks()
  hasStarted = () => this.everStarted
  subtitleList = () => this.subtitles
  wantedAudio = () => this.audioWant ?? this.profileAudio[0] ?? null
  originalAudio = () => this.original()
}

/** The play request a next episode makes, as a key for one asked ahead. */
/** (Keyed by who's watching too: another profile's answer has their resume point and picks.) */
const aheadPath = (type: string, id: string, binge: string | null, pick: string | null, profile: string) => `${type}/${id}?audio=${pick ?? '*'}&binge=${binge ?? ''}&p=${profile}`

/** "1:02:13", "4:05". */
function clock(ms: number) {
  const t = Math.floor(ms / 1000)
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), x = t % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`
}

/** Each source's key in a list: the server's (the same file whatever the list's order, one per debrid
 * service), or add-on, file name and label for a plugin's (its key comes from its link, which may change
 * from one lookup to the next); numbered when the same appears again. */
function keysOf(list: Stream[]): string[] {
  const seen = new Map<string, number>()
  return list.map(s => {
    const base = (!s.plugin && s.key) || `${s.addon}|${s.filename}|${s.label}`
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    return `${base}#${n}`
  })
}

/** What's said once back on the one you were watching. */
function backLine(b: Before) {
  if (b.language) return `${b.language} isn't available right now.${b.heard && b.heard !== b.language ? ` Still in ${b.heard}.` : ''}`
  if (b.quality) return `${b.quality} isn't available right now.${b.wasQuality ? ` Still in ${b.wasQuality}.` : ''}`
  return "That one isn't available right now. You're back where you were."
}
