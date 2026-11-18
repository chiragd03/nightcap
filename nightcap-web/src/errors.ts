// What went wrong, told in plain words. Every request the app makes fails in one of a few ways: no
// connection, an answer saying no (the server's own words, when it wrote them for people), or
// something else (a server error, a page from a proxy while it restarts). Screens show errorWords(e),
// never a raw message, and decide what to do by status or header, never by the words.

/** What the failed answer's body was: the server's JSON, a web page (a proxy, a server starting), or nothing. */
export type Body = 'json' | 'html' | 'none'

/** A request the server answered with an error. [message] is the server's text, kept for the console. */
export class ApiError extends Error {
  status: number
  body: Body
  headers: Headers
  constructor(message: string, status: number, body: Body, headers: Headers) {
    super(message)
    this.status = status
    this.body = body
    this.headers = headers
  }
}

/** An error whose message the app itself wrote for people (wrong PIN, a file too big). */
export class Said extends Error {}

/** Marks the fetch's own failure (no connection): the same TypeError object, so code that checks for
 * a TypeError still sees one. */
export function offline<E>(e: E): E {
  if (e instanceof TypeError) (e as TypeError & { offline?: true }).offline = true
  return e
}

/** The request never reached the server (no connection, the server gone). */
export const isOffline = (e: unknown) => e instanceof TypeError && (e as TypeError & { offline?: true }).offline === true

/** The answer of a server still starting: a proxy's page instead of the server's own. */
export const isStarting = (e: unknown) => e instanceof ApiError && e.body !== 'json' && (e.status === 502 || e.status === 503 || e.status === 504)

export const WORDS = {
  offline: "Couldn't reach the server. Try again.",
  starting: 'Nightcap is waking up. Try again in a moment.',
  missing: "This page isn't available right now.",
  tooBig: 'That file is too big.',
  other: 'Something went wrong. Try again in a moment.',
}

/** The words for [e]. The server's own text only for an answer saying no in words written for people
 * (a full sentence: "There are 3 invites open already: …"), never its internal ones ("bad id") or
 * a server error's. */
export function errorWords(e: unknown): string {
  if (e instanceof Said) return e.message
  if (isOffline(e)) return WORDS.offline
  if (!(e instanceof ApiError)) return WORDS.other
  if (isStarting(e)) return WORDS.starting
  if (e.status === 413) return WORDS.tooBig
  const forPeople = e.body === 'json' && /^[A-Z]/.test(e.message) && e.status >= 400 && e.status < 500
  if (forPeople) return e.message
  if (e.status === 404) return WORDS.missing
  return WORDS.other
}
