import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { Stream } from '../../../src/types'

// The Samsung/LG app's Host for the player session: its
// calls' error rules, the play path, and what it rules out. The app's request is faked.

const call = vi.fn()
const send = vi.fn()
vi.mock('../api', () => {
  class ServerError extends Error {
    status: number
    offline?: TypeError
    constructor(message: string, status: number, offline?: TypeError) { super(message); this.status = status; if (offline) this.offline = offline }
  }
  return { ServerError, call: (...a: unknown[]) => call(...a), send: (...a: unknown[]) => send(...a), TIMEOUT: { normal: 20_000, slow: 60_000 } }
})
vi.mock('../platform', () => ({ kind: 'tizen' }))

const api = await import('../api')
const { canPlay, pictureOf, playPath, tvHost } = await import('./tvHost')

const stream = (o: Partial<Stream> = {}): Stream => ({
  url: 'https://tv.test/s/abcdefghijklmnop0123/0', addon: 'A', filename: 'Film.2024.2160p.WEB-DL.mkv', resolution: '4K', hdr: [],
  size: 0, cached: true, direct: false, languages: ['en'], label: '', ...o,
})

beforeEach(() => {
  call.mockReset()
  send.mockReset()
  vi.stubGlobal('location', { origin: 'https://tv.test', protocol: 'https:' })
})

describe('calls', () => {
  test('the play answer: the session path, a 90 s wait', async () => {
    call.mockResolvedValue({ streams: [] })
    await tvHost.play('series', 'tt1:2:3', { binge: 'grp|x', audio: null, more: true })
    expect(call).toHaveBeenCalledWith('/launcher/play/series/tt1%3A2%3A3.json?audio=*&binge=grp%7Cx&more=1', { timeout: 90_000 })
    expect(playPath('movie', 'tt9', { audio: 'hi' })).toBe('/launcher/play/movie/tt9.json?audio=hi')
  })

  test('no connection is a TypeError, and only that', async () => {
    const offline = new TypeError('Failed to fetch')
    call.mockRejectedValueOnce(new api.ServerError("Couldn't reach the server. Try again.", 0, offline))
    await expect(tvHost.renewLinks('tok', 1)).rejects.toBe(offline)
    // (A timeout: no TypeError.)
    const timedOut = new api.ServerError("Couldn't reach the server. Try again.", 0)
    call.mockRejectedValueOnce(timedOut)
    await expect(tvHost.renewLinks('tok', 1)).rejects.toBe(timedOut)
    // (The server's own answer.)
    call.mockRejectedValueOnce(new api.ServerError('No', 500))
    await expect(tvHost.audioLanguages(['https://tv.test/s/x/1'])).rejects.not.toBeInstanceOf(TypeError)
  })

  test('versions are read by their link on this server', async () => {
    call.mockResolvedValue({ languages: [null] })
    await tvHost.audioLanguages(['https://tv.test/s/abc/1?x=1'])
    expect(call.mock.calls[0][1].body).toEqual({ links: ['/s/abc/1?x=1'] })
  })

  test('what a source did is told without marking anything changed', () => {
    tvHost.sourceFailed('tt1', 'A', "couldn't be opened", 'f.mkv')
    tvHost.sourceGone('tt1', '', 'k')
    tvHost.sourcePlayed('tt1', 'k')
    expect(send.mock.calls).toEqual([
      ['/launcher/source-failed', { id: 'tt1', addon: 'A', error: "couldn't be opened", filename: 'f.mkv' }],
      ['/launcher/source-failed', { id: 'tt1', addon: '?', key: 'k', dead: true }],
      ['/launcher/source-played', { id: 'tt1', key: 'k' }],
    ])
  })
})

describe('what plays here', () => {
  test('Dolby Vision only, by its name', () => {
    expect(pictureOf({ filename: 'Film.2024.2160p.DV.WEB-DL.mkv', hdr: [] }).dolbyVisionOnly).toBe(true)
    expect(pictureOf({ filename: 'Film.2024.2160p.DoVi.mkv', hdr: [] }).dolbyVisionOnly).toBe(true)
    expect(pictureOf({ filename: 'Film 2024 2160p Dolby Vision', hdr: [] }).dolbyVisionOnly).toBe(true)
    expect(pictureOf({ filename: 'Film.2024.2160p.DV.HDR10.mkv', hdr: [] }).dolbyVisionOnly).toBe(false)
    expect(pictureOf({ filename: 'Film.2024.2160p.DV.HDR10+.mkv', hdr: [] }).dolbyVisionOnly).toBe(false)
    expect(pictureOf({ filename: 'Film.2024.2160p.mkv', hdr: ['DV', 'HDR'] }).dolbyVisionOnly).toBe(false)
    expect(pictureOf({ filename: 'Film.1999.DVDRip.mkv', hdr: [] }).dolbyVisionOnly).toBe(false)
  })

  test('ruled out: Dolby Vision only on a Samsung, a plain http file on the https server', () => {
    const dv = stream({ filename: 'Film.2024.2160p.DV.WEB-DL.DDP5.1.Atmos.mkv' })
    expect(canPlay(dv, 'tizen', true)).toBe(false)
    expect(canPlay(dv, 'webos', true)).toBe(true)
    expect(canPlay(stream({ direct: true, url: 'http://files.test/f.mkv' }), 'webos', true)).toBe(false)
    expect(canPlay(stream({ direct: true, url: 'http://files.test/f.mkv' }), 'webos', false)).toBe(true)
    // (E-AC-3 with Atmos, TrueHD's name aside, VC-1: the TVs play them, or rank them, never rule them out.)
    expect(canPlay(stream({ filename: 'Film.2024.1080p.BluRay.TrueHD.Atmos.VC-1.mkv' }), 'tizen', true)).toBe(true)
    expect(canPlay(stream({ youtube: 'abcdefghijk', url: undefined, filename: 'DV' }), 'tizen', true)).toBe(true)
    expect(canPlay(stream({ plugin: true, browser: false }), 'tizen', true)).toBe(true)
  })
})
