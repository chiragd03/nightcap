import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { Events } from './engine'

// The <video> engine's own rules, on a stand-in video element: the resume seek kept to the file opened
// last and put right only once before it starts, "started" as the Android TV counts it, the end not taken
// for a pause. (How a real TV's player behaves is checked on the TV.)

class FakeVideo extends EventTarget {
  currentTime = 0
  duration = NaN
  paused = true
  ended = false
  seeking = false
  readyState = 0
  volume = 1
  className = ''
  preload = ''
  style: Record<string, string> = {}
  buffered = { length: 0, start: () => 0, end: () => 0 }
  textTracks = Object.assign([], { onaddtrack: null })
  seeks: number[] = []
  constructor() {
    super()
    let t = 0
    Object.defineProperty(this, 'currentTime', { get: () => t, set: (v: number) => { t = v; this.seeks.push(v) } })
  }
  setAttribute() {}
  removeAttribute() {}
  remove() {}
  load() {}
  play() { this.paused = false; return Promise.resolve() }
  pause() { this.paused = true }
  fire(name: string) { this.dispatchEvent(new Event(name)) }
  /** Playback reaching [t] (s), as timeupdate tells it. */
  at(t: number) {
    Object.getOwnPropertyDescriptor(this, 'currentTime')!.set!.call(this, t)
    this.seeks.pop()
    this.fire('timeupdate')
  }
}

let v: FakeVideo
let events: Events & { log: string[] }

beforeEach(() => {
  v = new FakeVideo()
  vi.stubGlobal('document', { createElement: () => v })
  const log: string[] = []
  events = {
    log,
    playing: () => log.push('playing'), started: () => log.push('started'), paused: () => log.push('paused'),
    time: () => {}, length: () => {}, buffering: () => {}, ended: () => log.push('ended'),
    error: () => log.push('error'), tracks: () => {}, cue: () => {},
  } as Events & { log: string[] }
})

async function engine() {
  const { VideoEngine } = await import('./video')
  return new VideoEngine({ appendChild: () => {} } as unknown as HTMLElement, events)
}

describe('the resume seek', () => {
  test('asked once the file says its length, and never put right mid-film', async () => {
    const e = await engine()
    e.open('https://cdn.test/a', 120_000)
    v.fire('loadedmetadata')
    expect(v.seeks).toEqual([120])
    v.fire('seeked')
    v.readyState = 4
    v.fire('canplay')
    v.fire('playing')
    v.at(120); v.at(120.5)
    expect(events.log).toContain('started')
    // Mid-film: a skip of yours, a stall, a track switch. canplay again: no jump back.
    v.at(3120)
    v.fire('canplay')
    expect(v.seeks).toEqual([120])
  })

  test("a platform player that dropped it: asked once more at the first canplay, before it starts", async () => {
    const e = await engine()
    e.open('https://cdn.test/a', 120_000)
    v.fire('loadedmetadata')
    // (The player starts from 0 anyway.)
    Object.getOwnPropertyDescriptor(v, 'currentTime')!.set!.call(v, 0)
    v.seeks.pop()
    v.fire('canplay')
    expect(v.seeks).toEqual([120, 120])
    v.fire('canplay')
    expect(v.seeks).toEqual([120, 120])
  })

  test("a file that failed before its length never seeks the next one", async () => {
    const e = await engine()
    e.open('https://cdn.test/a', 300_000)
    e.open('https://cdn.test/b', 0)
    v.fire('loadedmetadata')
    expect(v.seeks).toEqual([])
  })
})

describe('started, the Android TV way', () => {
  test('the picture up: a frame played and the time moving a little', async () => {
    const e = await engine()
    e.open('https://cdn.test/a', 0)
    v.readyState = 4
    v.fire('playing')
    v.at(0); v.at(0.2)
    expect(events.log).not.toContain('started')
    v.at(0.4)
    expect(events.log.filter(x => x === 'started')).toHaveLength(1)
    v.at(5)
    expect(events.log.filter(x => x === 'started')).toHaveLength(1)
  })

  test('no frame told: the time moved 1.5 s; a jump over 2 s starts the count again', async () => {
    const e = await engine()
    e.open('https://cdn.test/a', 0)
    v.at(0); v.at(10)
    expect(events.log).not.toContain('started')
    v.at(11)
    expect(events.log).not.toContain('started')
    v.at(11.6)
    expect(events.log).toContain('started')
  })
})

test('the end is the end, not a pause', async () => {
  const e = await engine()
  e.open('https://cdn.test/a', 0)
  v.ended = true
  v.fire('pause')
  v.fire('ended')
  expect(events.log).toEqual(['ended'])
})
