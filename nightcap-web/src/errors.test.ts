import { describe, expect, it } from 'vitest'
import { ApiError, errorWords, isOffline, offline, Said, WORDS } from './errors'

const answer = (status: number, message: string, body: 'json' | 'html' | 'none' = 'json', headers: Record<string, string> = {}) =>
  new ApiError(message, status, body, new Headers(headers))

describe('errorWords', () => {
  it("shows the server's sentences for people", () => {
    expect(errorWords(answer(409, 'There are 3 invites open already: cancel one'))).toBe('There are 3 invites open already: cancel one')
    expect(errorWords(answer(429, 'Too many wrong codes. Try again in a few minutes.'))).toBe('Too many wrong codes. Try again in a few minutes.')
  })
  it('never its internal words', () => {
    expect(errorWords(answer(400, 'bad id'))).toBe(WORDS.other)
    expect(errorWords(answer(404, 'not found'))).toBe(WORDS.missing)
    expect(errorWords(answer(500, 'Internal Server Error'))).toBe(WORDS.other)
  })
  it('a proxy page while the server starts', () => {
    expect(errorWords(answer(503, 'Request failed (503)', 'html'))).toBe(WORDS.starting)
    expect(errorWords(answer(502, 'Request failed (502)', 'none'))).toBe(WORDS.starting)
  })
  it('a file too big', () => expect(errorWords(answer(413, 'too big'))).toBe(WORDS.tooBig))
  it('no connection', () => expect(errorWords(offline(new TypeError('Failed to fetch')))).toBe(WORDS.offline))
  it("the app's own words", () => expect(errorWords(new Said("That isn't the admin PIN."))).toBe("That isn't the admin PIN."))
  it('anything else', () => expect(errorWords(new Error('x is undefined'))).toBe(WORDS.other))
})

describe('isOffline', () => {
  it('only the fetch failure marked as such', () => {
    const e = new TypeError('Failed to fetch')
    expect(isOffline(e)).toBe(false)
    expect(offline(e)).toBe(e)
    expect(isOffline(e)).toBe(true)
    expect(isOffline(new TypeError("Cannot read properties of undefined"))).toBe(false)
  })
})
