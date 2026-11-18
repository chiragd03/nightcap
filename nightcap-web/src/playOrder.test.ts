import { describe, expect, test } from 'vitest'
import * as PlayOrder from './playOrder'
import type { File } from './playOrder'

// Which file the player tries next (playOrder.ts): the Android TV's tests, case for case.
// Run: npm test

const F = (key: string, verified: boolean, more: Partial<File> = {}): File => ({ key, verified, ...more })

function order(files: File[], o: { want?: string | null; quality?: string | null; original?: string | null; now?: number } = {}) {
  const { want = null, quality = null, original = 'hi', now = 0 } = o
  const tried = new Set<string>()
  const out: string[] = []
  for (;;) {
    const i = PlayOrder.next(files, tried, { want, quality, original, now })
    if (i < 0) return out
    out.push(files[i].key)
    tried.add(files[i].key)
  }
}

describe('PlayOrder', () => {
  test('the account line when the only file left was refused', () => {
    const files = [F('a', true, { service: 'serviceb', skipped: true })]
    expect(PlayOrder.ending(files, new Set(['a']))).toBe('account')
  })

  test('the want only in dead files gets one try', () => {
    const files = [F('en', true, { languages: ['en'] }),
      F('hiNamed', true, { languages: ['hi'], dead: true }),
      F('hiHeard', true, { languages: ['hi'], fromHeader: true, dead: true })]
    expect(PlayOrder.deadWant(files, new Set(), 'hi', 'en')).toBe(2)
    // (Tried: the next dead one.)
    expect(PlayOrder.deadWant(files, new Set(['hiHeard']), 'hi', 'en')).toBe(1)
    // A living Hindi file left: not now.
    const living = [...files, F('hiOk', true, { languages: ['hi'] })]
    expect(PlayOrder.deadWant(living, new Set(), 'hi', 'en')).toBe(-1)
    // Nothing in Hindi at all.
    expect(PlayOrder.deadWant(files.slice(0, 1), new Set(), 'hi', 'en')).toBe(-1)
  })

  test("no pick keeps the server's order", () => {
    const files = [F('a', true), F('b', true), F('c', false), F('d', true)]
    expect(order(files)).toEqual(['a', 'b', 'd', 'c'])
  })

  test('never suspect, not downloaded, skipped or unopenable', () => {
    const files = [F('s', true, { suspect: true }), F('n', true, { notDownloaded: true }),
      F('k', true, { skipped: true }), F('o', true, { openable: false }), F('ok', true)]
    expect(order(files)).toEqual(['ok'])
  })

  test('a not-downloaded file is tried when allowed', () => {
    const files = [F('n', true, { notDownloaded: true }), F('ok', true)]
    expect(PlayOrder.next(files, new Set(), { allowed: new Set(['n']), first: 'n' })).toBe(0)
  })

  test('wanted language first but never before verified', () => {
    const files = [
      F('en4k', true, { languages: ['en'], resolution: '4K' }),
      F('hiUnverified', false, { languages: ['hi'] }),
      F('hi720', true, { languages: ['hi'], resolution: '720p' }),
    ]
    expect(order(files, { want: 'hi' })).toEqual(['hi720', 'en4k', 'hiUnverified'])
  })

  test('wanted language and quality together first', () => {
    const files = [
      F('hi720', true, { languages: ['hi'], resolution: '720p' }),
      F('en1080', true, { languages: ['en'], resolution: '1080p' }),
      F('hi1080', true, { languages: ['hi'], resolution: '1080p' }),
    ]
    expect(order(files, { want: 'hi', quality: '1080p' })).toEqual(['hi1080', 'hi720', 'en1080'])
  })

  test('header confirmed, then named, then names none', () => {
    const files = [
      F('none', true),
      F('named', true, { languages: ['en'] }),
      F('header', true, { languages: ['en', 'hi'], fromHeader: true }),
    ]
    expect(order(files, { want: 'en', original: 'hi' })).toEqual(['header', 'named', 'none'])
  })

  test("a file naming no language is English or the title's own", () => {
    const none = F('none', true)
    expect(PlayOrder.speaks(none, 'en', 'ko')).toBe(true)
    expect(PlayOrder.speaks(none, 'ko', 'ko')).toBe(true)
    expect(PlayOrder.speaks(none, 'hi', 'ko')).toBe(false)
  })

  test('a quality pick alone', () => {
    const files = [F('720', true, { resolution: '720p' }), F('4k', true, { resolution: '4K' }),
      F('u4k', false, { resolution: '4K' })]
    expect(order(files, { quality: '4K' })).toEqual(['4k', '720', 'u4k'])
  })

  test('seen, then tripped, sink only within their group', () => {
    const files = [
      F('hiTripped', true, { languages: ['hi'], sunk: true }),
      F('hiSeen', true, { languages: ['hi'], seen: true }),
      F('en', true, { languages: ['en'] }),
      F('hi', true, { languages: ['hi'] }),
    ]
    expect(order(files, { want: 'hi' })).toEqual(['hi', 'hiSeen', 'hiTripped', 'en'])
  })

  test('preparing and busy wait their turn, then dead last', () => {
    const files = [F('dead', true, { dead: true }), F('busy', true, { busyUntil: 50 }),
      F('prep', true, { preparingUntil: 20 }), F('ok', true)]
    expect(order(files, { now: 10 })).toEqual(['ok'])
    expect(order(files, { now: 100 })).toEqual(['ok', 'prep', 'busy', 'dead'])
    expect(PlayOrder.soonest(files, new Set(['ok']))).toBe(20)
  })

  test('first overrides the order, and tried is never again', () => {
    const files = [F('a', true), F('b', true), F('c', true)]
    expect(PlayOrder.next(files, new Set(), { first: 'c' })).toBe(2)
    expect(PlayOrder.next(files, new Set(['a']))).toBe(1)
    expect(PlayOrder.next(files, new Set(['a', 'b', 'c']))).toBe(-1)
  })

  test('dead only when allowed', () => {
    const files = [F('dead', true, { dead: true })]
    expect(PlayOrder.next(files, new Set(), { withDead: false })).toBe(-1)
    expect(PlayOrder.next(files, new Set())).toBe(0)
  })

  test('no original language means "names none" is English only', () => {
    expect(PlayOrder.speaks(F('x', true), 'en', null)).toBe(true)
    expect(PlayOrder.speaks(F('x', true), 'hi', null)).toBe(false)
  })

  test('unverified with the want before the unverified rest, with a quality pick', () => {
    const files = [F('uEn', false, { languages: ['en'], resolution: '4K' }),
      F('uHi', false, { languages: ['hi'], resolution: '720p' })]
    expect(order(files, { want: 'hi', quality: '4K' })).toEqual(['uHi', 'uEn'])
  })

  // ----- Services: what a refusal or a busy service holds back, and how a play ends -----

  const aTorrent = F('aT', true, { service: 'servicea', kind: 'debrid' })
  const aUsenet = F('aU', true, { service: 'servicea', kind: 'usenet' })
  const b = F('b', true, { service: 'serviceb', kind: 'debrid' })
  const direct = F('direct', true)

  test('a ServiceA bad key leaves ServiceB', () => {
    const files = PlayOrder.apply([aTorrent, aUsenet, b, direct], [{ type: 'badKey', service: 'servicea' }])
    expect(order(files)).toEqual(['b', 'direct'])
  })

  test('usenet not in the plan leaves torrents', () => {
    const files = PlayOrder.apply([aUsenet, aTorrent], [{ type: 'notInPlan', service: 'servicea', kind: 'usenet' }])
    expect(order(files)).toEqual(['aT'])
  })

  test('usenet not in the plan, with a not-downloaded torrent left, starts it, not the account line', () => {
    const waiting = F('aWait', true, { service: 'servicea', kind: 'debrid', notDownloaded: true })
    const files = PlayOrder.apply([aUsenet, aTorrent, waiting], [{ type: 'notInPlan', service: 'servicea', kind: 'usenet' }])
    expect(PlayOrder.ending(files, new Set(['aT']))).toBe('prepare')
    const onlyUsenet = PlayOrder.apply([aUsenet], [{ type: 'notInPlan', service: 'servicea', kind: 'usenet' }])
    expect(PlayOrder.ending(onlyUsenet, new Set())).toBe('account')
  })

  test("a ServiceA busy doesn't hold back ServiceB or direct files", () => {
    const files = PlayOrder.apply([aTorrent, b, direct], [{ type: 'busy', service: 'servicea', kind: 'debrid', until: 60_000 }])
    expect(order(files, { now: 1_000 })).toEqual(['b', 'direct'])
    expect(PlayOrder.ending(files, new Set(['b', 'direct']))).toBe('busy')
  })

  test("a usenet busy doesn't hold back that service's torrents", () => {
    const files = PlayOrder.apply([aUsenet, aTorrent], [{ type: 'busy', service: 'servicea', kind: 'usenet', until: 60_000 }])
    expect(order(files, { now: 1_000 })).toEqual(['aT'])
  })

  test('a sink stays within the wanted language', () => {
    const hiA = F('hiA', true, { languages: ['hi'], service: 'servicea', kind: 'debrid' })
    const enB = F('enB', true, { languages: ['en'], service: 'serviceb', kind: 'debrid' })
    const files = PlayOrder.apply([hiA, enB], [{ type: 'sink', service: 'servicea' }])
    expect(order(files, { want: 'hi' })).toEqual(['hiA', 'enB'])
  })

  test('a file with no service never trips', () => {
    const files = PlayOrder.apply([direct], [{ type: 'badKey', service: 'servicea' }, { type: 'busy', service: 'servicea', kind: null, until: 9_999 }])
    expect(order(files)).toEqual(['direct'])
  })

  test('endings in order', () => {
    expect(PlayOrder.ending([F('a', true)], new Set(['a']))).toBe('couldntPlay')
    expect(PlayOrder.ending([F('a', true), F('n', true, { notDownloaded: true })], new Set(['a']))).toBe('prepare')
  })

  test('wait for the wanted language only once, and only if time is left', () => {
    const busyHi = F('hi', true, { languages: ['hi'], busyUntil: 60_000 })
    const files = [busyHi, F('en', true, { languages: ['en'] })]
    // 60 s to wait, then up to 53 s for the try, and 45 s kept: fits a budget ending at 200 s, not at 150 s.
    expect(PlayOrder.waitBeforeLeaving(files, new Set(), 'hi', null, 0, 200_000, false)).toBe(60_000)
    expect(PlayOrder.waitBeforeLeaving(files, new Set(), 'hi', null, 0, 150_000, false)).toBe(null)
    expect(PlayOrder.waitBeforeLeaving(files, new Set(), 'hi', null, 0, 200_000, true)).toBe(null)
  })

  test('mainLeft counts only the main groups', () => {
    const files = [F('a', true), F('b', true, { seen: true }), F('c', true, { busyUntil: 5 }),
      F('d', true, { dead: true }), F('e', true)]
    expect(PlayOrder.mainLeft(files, new Set())).toBe(2)
    expect(PlayOrder.mainLeft(files, new Set(['a']))).toBe(1)
  })
})
