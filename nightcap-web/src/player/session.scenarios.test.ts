import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { notOutYet } from './words'
import type { Play, Stream } from '../types'

// How a play goes, start to end, as the player session does it (the Android TV's rules): the
// server's answers and the hosts' are scripted, time is faked. These pin the behaviour down (the
// session is shared with the Samsung/LG app), so a change that
// alters it shows here.

// ---------- A scripted server ----------

const TOK = 'abcdefghijklmnop0123'
type LinkReply = { status: number; headers?: Record<string, string>; where?: { url: string; direct: boolean } } | 'hang'
type HostReply = { status: number; retryAfter?: number } | 'silent' | 'opaque' | 'refused'

const server = {
  play: null as Play | null,
  /** The replies to each file's link, by index, in turn (the last one repeats). */
  link: new Map<number, LinkReply[]>(),
  /** The CDN's replies to the page's one-byte look, by address, in turn (the last one repeats). */
  host: new Map<string, HostReply[]>(),
  renew: 'ok' as 'ok' | 'fail',
  asked: [] as string[],
  failed: [] as string[],
}
const next = <T>(list: T[] | undefined, fallback: T): T => (!list?.length ? fallback : list.length > 1 ? list.shift()! : list[0])

// The app's side (session.ts's Host), as a test host: the scripted server, and an app that plays everything.
const host = {
  play: vi.fn(async () => {
    if (!server.play) throw new Error('no answer')
    return JSON.parse(JSON.stringify(server.play)) as Play
  }),
  askLink: vi.fn(async (link: string, signal: AbortSignal) => {
    server.asked.push(link)
    const i = Number(/\/(\d+)(\?|$)/.exec(link)?.[1])
    const r = next(server.link.get(i), { status: 200, where: { url: `https://cdn.test/f${i}`, direct: false } } as LinkReply)
    if (r === 'hang') return new Promise<never>((_, no) => signal.addEventListener('abort', () => no(Object.assign(new Error('aborted'), { name: 'AbortError' }))))
    const h = new Map(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]))
    return { status: r.status, retryAfter: Number(h.get('retry-after')) || null, header: (n: string) => h.get(n.toLowerCase()) ?? null, where: r.where }
  }),
  renewLinks: vi.fn(async () => {
    if (server.renew === 'fail') throw new Error('no')
    return { token: 'zyxwvutsrqponmlk9876', linksExpireAt: Date.now() + 6 * 3600_000 }
  }),
  audioLanguages: vi.fn(async () => ({ languages: [] })),
  sourceFailed: vi.fn((_id: string, _addon: string, why: string) => { server.failed.push(why) }),
  sourceGone: vi.fn(),
  sourcePlayed: vi.fn(),
  canPlay: () => true,
  tracksSwitchable: () => false,
  nothingPlaysHere: 'Nothing plays here',
  notOutYet: (r: string) => `Not out yet (${r})`,
  headerIndexes: false,
  profileKey: () => 'p1',
}

// The page's one-byte look at a CDN address.
function fakeFetch(url: string, init: RequestInit): Promise<Response> {
  const r = next(server.host.get(url), { status: 206 } as HostReply)
  const signal = init.signal!
  if (r === 'silent') return new Promise((_, no) => signal.addEventListener('abort', () => no(Object.assign(new Error('aborted'), { name: 'AbortError' }))))
  const plain = (init as { mode?: string }).mode === 'no-cors'
  // (A CORS refusal: only the page's own read fails; a plain ask still gets its answer, unread.)
  if (r === 'refused' && !plain) return Promise.reject(new TypeError('Failed to fetch'))
  if (r === 'opaque' || r === 'refused' || plain) return Promise.resolve({ type: 'opaque', status: 0, headers: new Headers(), body: null } as unknown as Response)
  return Promise.resolve({ type: 'cors', status: r.status, headers: new Headers(r.retryAfter ? { 'Retry-After': String(r.retryAfter) } : {}), body: null } as unknown as Response)
}

function stream(i: number, more: Partial<Stream> = {}): Stream {
  return {
    url: `/s/${TOK}/${i}`, addon: 'AIOStreams', filename: `Film.2024.1080p.WEB-DL.${i}.mkv`, resolution: '1080p', hdr: [],
    size: 2e9, cached: true, direct: false, languages: ['en'], label: '1080p · WEB-DL', key: `k${i}`, verified: true,
    service: 'servicea', kind: 'debrid', ...more,
  } as Stream
}
function answer(streams: Stream[], more: Partial<Play> = {}): Play {
  return { id: 'tt0000001', type: 'movie', name: 'Film', resume: 0, runtimeMs: 7200_000, streams, subtitles: [], why: [], asked: [], linksExpireAt: Date.now() + 6 * 3600_000, ...more } as Play
}

// ---------- The session under test ----------

type S = import('./session').Session
type V = import('./session').View
let M: typeof import('./session')
let s: S
let view: V

async function start(play: Play, type = 'movie', vid = 'tt0000001') {
  server.play = play
  s = new M.Session(type, vid, null, {}, null, host)
  s.onChange(v => { view = v })
  void s.load()
  await vi.advanceTimersByTimeAsync(0)
}
const settle = (ms = 0) => vi.advanceTimersByTimeAsync(ms)
/** The file open now, played: its first picture after a moment. */
async function plays() {
  const o = view.open!
  s.startedPlaying(o.attempt, o.at)
  await settle(0)
}

beforeEach(async () => {
  vi.useFakeTimers()
  vi.stubGlobal('fetch', vi.fn(fakeFetch))
  vi.stubGlobal('location', { protocol: 'https:', origin: 'https://nightcap.test' })
  server.play = null
  server.link = new Map()
  server.host = new Map()
  server.renew = 'ok'
  server.asked = []
  server.failed = []
  vi.resetModules()
  M = await import('./session')
})
afterEach(() => {
  s?.close()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

// ---------- Scenarios ----------

describe('a play, start to end', () => {
  test('the first verified file opens at its address, asked by its link', async () => {
    await start(answer([stream(0, { verified: false }), stream(1)]))
    expect(view.open?.index).toBe(1)
    expect(view.open?.url).toBe('https://cdn.test/f1')
    expect(view.loading).toBe(true)
    await plays()
    expect(view.loading).toBe(false)
    expect(view.everStarted).toBe(true)
  })

  test('a gone file: the next one, at once', async () => {
    server.link.set(0, [{ status: 502, headers: { 'X-Dead': 'file' } }])
    await start(answer([stream(0), stream(1)]))
    expect(view.open?.index).toBe(1)
  })

  test("a busy service's files wait while another service's play", async () => {
    server.link.set(0, [{ status: 503, headers: { 'X-Busy': '1', 'X-Service': 'servicea', 'X-Kind': 'debrid', 'Retry-After': '60' } }])
    await start(answer([stream(0), stream(1), stream(2, { service: 'serviceb' })]))
    // (Both ServiceA files wait: ServiceB's opens.)
    expect(view.open?.index).toBe(2)
  })

  test('expired links are renewed, and the same file asked again with the new token', async () => {
    server.link.set(0, [{ status: 410 }, { status: 200, where: { url: 'https://cdn.test/f0', direct: false } }])
    await start(answer([stream(0), stream(1)]))
    expect(view.open?.index).toBe(0)
    expect(server.asked.at(-1)).toContain('zyxwvutsrqponmlk9876')
  })

  test('the account refused (its only service): the account line', async () => {
    server.link.set(0, [{ status: 502, headers: { 'X-Dead': 'account', 'X-Service': 'servicea', 'X-Kind': 'debrid', 'X-Why': 'key' } }])
    await start(answer([stream(0)]))
    expect(view.ended).toBe(M.ACCOUNT_PROBLEM)
    expect(view.open).toBe(null)
  })

  test("a file that doesn't start in 30 s: the next", async () => {
    await start(answer([stream(0), stream(1)]))
    expect(view.open?.index).toBe(0)
    await settle(30_000)
    expect(view.open?.index).toBe(1)
  })

  test('nothing left to try: Keep trying, which tries again', async () => {
    await start(answer([stream(0)]))
    await settle(30_000)
    expect(view.card).toBe('keepTrying')
    expect(view.open).toBe(null)
    s.keepTrying()
    await settle(0)
    expect(view.card).toBe(null)
    expect(view.open?.index).toBe(0)
  })

  test("only another episode's files: asked whether to play one anyway", async () => {
    await start(answer([stream(0, { otherEpisode: 'S1 E2' })], { type: 'series', id: 'tt0000002:1:1' }), 'series', 'tt0000002:1:1')
    expect(view.card).toBe('otherEpisodes')
    s.playOtherEpisodes()
    await settle(0)
    expect(view.open?.index).toBe(0)
  })

  test('no sources at all: the server\'s line, else "nothing yet"', async () => {
    await start(answer([], { notice: null }))
    expect(view.ended).toBe(M.NOTHING_YET)
  })

  test('a file being prepared: the next meanwhile', async () => {
    server.link.set(0, [{ status: 502, headers: { 'X-Preparing': '1' } }])
    await start(answer([stream(0), stream(1)]))
    expect(view.open?.index).toBe(1)
  })
})

describe("the page's look at a host", () => {
  test('a host failing twice (5xx): the next copy', async () => {
    server.host.set('https://cdn.test/f0', [{ status: 503 }])
    await start(answer([stream(0), stream(1)]))
    await settle(3_000)
    expect(view.open?.index).toBe(1)
  })

  test('a host sending nothing: the next copy after its 8 s look and a 4 s plain ask', async () => {
    server.host.set('https://cdn.test/f0', ['silent'])
    await start(answer([stream(0), stream(1)]))
    expect(view.open).toBe(null)
    await settle(12_000)
    expect(view.open?.index).toBe(1)
  })

  test('a look that gets nothing but a plain ask answered (a preflight never answered): opened', async () => {
    server.host.set('https://cdn.test/f0', ['silent', { status: 206 }])
    await start(answer([stream(0), stream(1)]))
    await settle(8_000)
    expect(view.open?.index).toBe(0)
  })

  test('a host the page may not read (CORS): opened as it is', async () => {
    server.host.set('https://cdn.test/f0', ['refused'])
    await start(answer([stream(0)]))
    expect(view.open?.index).toBe(0)
  })
})

describe('mid-film', () => {
  test('an error after it played: the same file again, from where it was', async () => {
    await start(answer([stream(0), stream(1)]))
    await plays()
    const first = view.open!.attempt
    s.time(first, 600_000)
    s.error(first, 'stopped arriving')
    await settle(0)
    expect(view.open?.index).toBe(0)
    expect(view.open?.at).toBe(600_000)
    expect(view.line).toBe(M.RECONNECTING)
  })

  test('a pause before the picture (the page blocked) never counts as not starting', async () => {
    await start(answer([stream(0), stream(1)]))
    s.blocked(view.open!.attempt)
    await settle(60_000)
    expect(view.open?.index).toBe(0)
  })
})

describe('words', () => {
  test("not out yet, as the Android TV says it", () => {
    expect(notOutYet('2026-11-08')).toBe('Not out yet. Comes out 8 Nov 2026')
    expect(notOutYet('2027-01-30T00:00:00Z')).toBe('Not out yet. Comes out 30 Jan 2027')
    expect(notOutYet('')).toBe('Not out yet')
  })

  test("the host's ending when nothing here can play", async () => {
    await start(answer([stream(0)]), 'movie')
    s.close()
    const h = { ...host, canPlay: () => false }
    s = new M.Session('movie', 'tt0000001', null, {}, null, h)
    s.onChange(v => { view = v })
    void s.load()
    await settle(0)
    expect(view.ended).toBe('Nothing plays here')
  })
})

describe("a file's own audio tracks, as the Android TV", () => {
  test('one row per language, a commentary only when there is no other, a track with no language by its number', async () => {
    await start(answer([stream(0)]))
    await plays()
    s.setTracks(view.open!.attempt, {
      languages: ['en', 'en', 'hi', null], playing: 1,
      names: ['English Commentary', 'English 5.1', 'Hindi', 'Stereo'],
    })
    const { here } = s.audioChoices()
    expect(here.map(h => [h.code, h.track, h.on])).toEqual([['en', 1, true], ['hi', 2, false], [null, 3, false]])
  })

  test('a track that says no language is "Audio N"; where it can\'t seek, "Audio: …" said, not held', async () => {
    await start(answer([stream(0)]))
    await plays()
    s.setTracks(view.open!.attempt, { languages: ['en', null], playing: 0 })
    s.pickTrack(null, false, 1, () => true, false)
    expect(view.held).toBe(null)
    expect(view.note?.text).toBe('Audio: Audio 2')
    s.pickTrack('en', false, 0, () => true)
    expect(view.held).toBe('Switching to English…')
  })

  test('the track to open: the wanted language by the header only where the app allows it and the counts agree', async () => {
    await start(answer([stream(0, { fileAudio: ['en', 'hi'] })], { audioLanguage: 'hi' }))
    // (This host doesn't open by the header's places: by language.)
    expect(s.openTrack(['en', 'hi'])).toBe(1)
    // (By language, a commentary never.)
    expect(s.openTrack(['hi', 'hi', 'en'], ['Hindi commentary', 'Hindi', 'English'])).toBe(1)
  })

  test('the late correction: a track named in the wanted language while another plays; not when opened by number', async () => {
    await start(answer([stream(0)], { audioLanguage: 'hi' }))
    await plays()
    const listed = { languages: ['en', 'hi'], playing: 0 }
    expect(s.lateCorrection(listed)).toBe(1)
    expect(s.lateCorrection({ ...listed, playing: 1 })).toBe(null)
    // (Once a track was recorded playing in this file, it's kept: no correction over it.)
    s.setTracks(view.open!.attempt, listed)
    expect(s.lateCorrection(listed)).toBe(null)
  })
})
