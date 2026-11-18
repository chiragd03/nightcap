/**
 * Which file the player tries next, and how a play ends when nothing is left: one rule for the
 * start, after a failure, a pick's candidates and the next episode. A port of the Android TV's
 * rule, as it is (its tests too: playOrder.test.ts), shared by the web player and the
 * Samsung/LG one.
 *
 * Main groups, in order:
 * - with a picked language (the *want*): verified + want + quality → verified + want → verified rest →
 *   unverified + want → unverified rest; inside each "+ want" group the want confirmed by the file's own
 *   header first, then named by its file name, then files naming no language;
 * - with no want but a picked quality: verified + quality → verified → unverified + quality → unverified;
 * - neither: the server's order (it ranks by the profile's language and quality).
 * Within each main group, after its other files: files with a recent sighting, then files of a tripped
 * add-on and service. After every main group: files being prepared, busy files (each once its time has
 * come), then dead ones. Within a group, the server's order.
 * Never: a file that seems to be another one's (suspect), one the debrid service hasn't downloaded
 * (opening it starts a download; unless next's `allowed`), one tried this play, one with nothing to
 * open, or one of a service (and type) whose key or plan refused it.
 */

export type File = {
  /** Stays the same for the same file through the play. */
  key: string
  verified: boolean
  /** Seems to be another episode's or title's file (otherEpisode, otherLength). */
  suspect?: boolean
  /** The debrid service hasn't got it (`cached: false`). */
  notDownloaded?: boolean
  /** Has an address or a YouTube id (default true). */
  openable?: boolean
  /** Its audio languages (two-letter codes). */
  languages?: string[]
  /** Whether languages came from the file's own header (else from its name). */
  fromHeader?: boolean
  /** "4K", "1080p", "720p", "480p" or "". */
  resolution?: string
  /** The debrid service it goes through ("servicea"), or null (a direct file, a plugin's). */
  service?: string | null
  /** AIOStreams' stream type: "usenet" or "debrid" (torrents), or null. */
  kind?: string | null
  /** A recent sighting (the server's `seen`): last within its group. */
  seen?: boolean
  /** Its add-on and service were tripped (a 403, a store limit): last within its group. */
  sunk?: boolean
  /** Its service (and type) refused it (a bad key; the plan lacks it): never tried by itself. */
  skipped?: boolean
  /** Being prepared: not before this time (ms). */
  preparingUntil?: number | null
  /** Busy: not before this time (ms). */
  busyUntil?: number | null
  /** Recorded dead by the server: tried only when nothing else is left. */
  dead?: boolean
}

/** What a service told the player this play. kind: only files of that type (null: all of the service's). */
export type Trip =
  /** A bad key (401): that service's files are skipped. */
  | { type: 'badKey'; service: string; kind?: null }
  /** The plan lacks it (payment_required): that service's files of that type are skipped. */
  | { type: 'notInPlan'; service: string; kind: string }
  /** A 403 or a store limit twice: that service's files sink within their groups. */
  | { type: 'sink'; service: string; kind?: null }
  /** Busy (429 and the like): that service's files of that type wait until `until`. */
  | { type: 'busy'; service: string; kind: string | null; until: number }

const openable = (f: File) => f.openable !== false
const langs = (f: File) => f.languages ?? []

/** files with what trips say marked on them. A file with no service never trips, sinks or goes busy. */
export function apply(files: File[], trips: Trip[]): File[] {
  return files.map(f => {
    const s = f.service
    if (!s) return f
    let out = f
    for (const t of trips) {
      if (t.service !== s || (t.kind != null && t.kind !== f.kind)) continue
      if (t.type === 'badKey' || t.type === 'notInPlan') out = { ...out, skipped: true }
      else if (t.type === 'sink') out = { ...out, sunk: true }
      else out = { ...out, busyUntil: Math.max(out.busyUntil ?? 0, t.until) }
    }
    return out
  })
}

/**
 * How well file has language: 0 its header says so, 1 its name says so, 2 it names no language and
 * language is English or the title's own (original), 3 not. One rule with the server's.
 */
export function level(file: File, language: string, original: string | null | undefined): number {
  if (langs(file).includes(language)) return file.fromHeader ? 0 : 1
  if (langs(file).length === 0 && (language === 'en' || language === original)) return 2
  return 3
}

export const speaks = (file: File, language: string | null | undefined, original: string | null | undefined) =>
  language == null || level(file, language, original) < 3

/** Whether file may be tried at all this play. */
export const usable = (file: File, tried: Set<string>, allowed: Set<string> = new Set()) =>
  openable(file) && !file.suspect && !file.skipped && !tried.has(file.key) && (!file.notDownloaded || allowed.has(file.key))

/** The first of indices whose keys are least, in order (ties keep the first, as on the Android TV). */
function minBy(indices: number[], keys: (i: number) => number[]): number | undefined {
  let best: number | undefined, bestKeys: number[] | undefined
  for (const i of indices) {
    const k = keys(i)
    if (!bestKeys || compare(k, bestKeys) < 0) { best = i; bestKeys = k }
  }
  return best
}
function compare(a: number[], b: number[]) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}

export type NextOptions = {
  want?: string | null; quality?: string | null; original?: string | null
  allowed?: Set<string>; first?: string | null; now?: number; withDead?: boolean
}

/**
 * The index in files (the server's order) of the next file to try now, or -1. want: a picked language
 * (null: none); quality: a picked quality (null: Auto); original: the title's own language; first: a key
 * tried before anything else when usable; now: the time (ms), for files being prepared or busy;
 * withDead: whether dead files may be tried (only when nothing else is).
 */
export function next(files: File[], tried: Set<string>, o: NextOptions = {}): number {
  const { want = null, quality = null, original = null, allowed = new Set<string>(), first = null, now = 0, withDead = true } = o
  const left = files.map((_, i) => i).filter(i => usable(files[i], tried, allowed))
  if (first != null) {
    const f = left.find(i => files[i].key === first)
    if (f != null) return f
  }
  const main = left.filter(i => !files[i].dead && files[i].preparingUntil == null && files[i].busyUntil == null)
  const best = minBy(main, i => [group(files[i], want, quality, original), within(files[i]), wantLevel(files[i], want, original), i])
  if (best != null) return best
  const prep = left.find(i => { const t = files[i].preparingUntil; return t != null && t <= now })
  if (prep != null) return prep
  const busy = left.find(i => { const t = files[i].busyUntil; return t != null && t <= now })
  if (busy != null) return busy
  // (Files still waiting their time come before a dead one: the caller waits for them, see soonest.)
  if (left.some(i => files[i].preparingUntil != null || files[i].busyUntil != null)) return -1
  return withDead ? left.find(i => files[i].dead) ?? -1 : -1
}

/** When the soonest file now waiting (being prepared, or busy) may be tried, or null if none is. */
export function soonest(files: File[], tried: Set<string>, allowed: Set<string> = new Set()): number | null {
  const times = files.filter(f => usable(f, tried, allowed)).map(f => f.preparingUntil ?? f.busyUntil).filter((t): t is number => t != null)
  return times.length ? Math.min(...times) : null
}

/** How many files are left in the main groups (for asking for more sources when few are). */
export const mainLeft = (files: File[], tried: Set<string>) =>
  files.filter(f => usable(f, tried) && !f.dead && !f.seen && !f.sunk && f.preparingUntil == null && f.busyUntil == null).length

/** The longest one waited-for try takes (its address asked, checked, started). */
export const TRY_MS = 53_000
/** Budget kept for the other language after a wait for the wanted one. */
export const KEEP_MS = 45_000

/**
 * Before the walk leaves the wanted language for another: how long to wait (ms) for a busy or preparing
 * file in it, or null not to wait. Once per play (waitedAlready); only when, once the waited try is over
 * (~TRY_MS), at least KEEP_MS of the budget would still be left.
 */
export function waitBeforeLeaving(files: File[], tried: Set<string>, want: string, original: string | null | undefined,
  now: number, budgetEnd: number, waitedAlready: boolean): number | null {
  if (waitedAlready) return null
  const times = files.filter(f => usable(f, tried) && speaks(f, want, original) && !f.dead)
    .map(f => f.preparingUntil ?? f.busyUntil).filter((t): t is number => t != null)
  if (!times.length) return null
  const at = Math.max(Math.min(...times), now)
  return at + TRY_MS + KEEP_MS <= budgetEnd ? at - now : null
}

/**
 * Before the walk leaves the wanted language for another: the best dead file that has it (header-confirmed
 * first, then named, then names none; verified first), to be tried once, when no other file in it is left
 * to try or wait for; or -1.
 */
export function deadWant(files: File[], tried: Set<string>, want: string, original: string | null | undefined): number {
  const left = files.map((_, i) => i).filter(i => usable(files[i], tried) && speaks(files[i], want, original))
  if (left.some(i => !files[i].dead)) return -1
  return minBy(left, i => [files[i].verified ? 0 : 1, level(files[i], want, original), i]) ?? -1
}

/** How a play ends when nothing is left to try. */
export type Ending = 'account' | 'busy' | 'prepare' | 'couldntPlay'

/**
 * Which line ends the play: the account line only when every file still untried was skipped by a
 * refusal's own scope (and none of them could be started instead); the busy line when busy files were
 * left; starting a not-downloaded file when one is left outside a refusal's scope; otherwise "Couldn't play".
 */
export function ending(files: File[], tried: Set<string>): Ending {
  // (A refused file counts as left, tried or not: the account is why it's over.)
  const untried = files.filter(f => openable(f) && !f.suspect && (!tried.has(f.key) || f.skipped))
  const startable = untried.filter(f => f.notDownloaded && !f.skipped)
  if (untried.length && untried.every(f => f.skipped)) return 'account'
  if (untried.some(f => f.busyUntil != null && !f.skipped)) return 'busy'
  if (startable.length) return 'prepare'
  return 'couldntPlay'
}

/** The main group a file is tried in, lowest first. */
export function group(file: File, want: string | null | undefined, quality: string | null | undefined, original: string | null | undefined) {
  const unverified = file.verified ? 0 : 3
  const has = want == null || speaks(file, want, original)
  const sharp = quality == null || file.resolution === quality
  return unverified + (has && sharp ? 0 : has ? 1 : 2)
}

/** Within a main group: others, then recently seen, then a tripped add-on's. */
const within = (file: File) => (file.sunk ? 2 : file.seen ? 1 : 0)

/** Inside a "+ want" group: header-confirmed, named, names none. */
const wantLevel = (file: File, want: string | null | undefined, original: string | null | undefined) =>
  want == null ? 0 : Math.min(level(file, want, original), 2)
