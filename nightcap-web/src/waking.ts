// The server sleeps when nobody uses it (Cloud Run scales to zero), and its first answer after a
// quiet spell takes a few seconds while it starts. The app's page itself comes from the browser's
// kept copy then (sw.template.js), so the app says "Waking up" (components/Waking) instead of seeming
// stuck: when a request goes out after a quiet spell (or the first since the page opened) and nothing
// has come back a moment later. Requests that are slow anyway (the AI, a play's sources, a refresh,
// moving households) don't count.

const FIRST_AFTER_MS = 1200
const LATER_AFTER_MS = 3000
/** How long without an answer before the server may have gone to sleep. */
const QUIET_MS = 15 * 60_000
const SLOW = /^\/(launcher\/(refresh|page\/[^/]+\/refresh|similar\/.+\/rank|search\/ai\.json|play\/)|server\/(export|import))/

let answeredAt = 0
let timer: ReturnType<typeof setTimeout> | undefined
let shown = false
/** Nothing has come back yet since the page opened (so there may be nothing to show). */
export const neverAnswered = () => answeredAt === 0 && !gaveUp
// (Shown over everything once at most: a server still not answering after that gets the small line.)
let gaveUp = false
// (Shown at most this long: a server that's down, not starting, leaves it to the screens' own errors.)
const GIVE_UP_MS = 45_000
let giveUp: ReturnType<typeof setTimeout> | undefined
const listeners = new Set<(shown: boolean) => void>()

function set(value: boolean) {
  if (shown === value) return
  shown = value
  clearTimeout(giveUp)
  if (value) giveUp = setTimeout(() => { gaveUp = true; set(false) }, GIVE_UP_MS)
  listeners.forEach(l => l(value))
}

export function onWaking(l: (shown: boolean) => void) {
  listeners.add(l)
  l(shown)
  return () => { listeners.delete(l) }
}

let saving = 0
/** How many changes are on their way to the server (not GET): a new version doesn't reload under one. */
export const writing = () => saving

/** Watches the app's own requests (to this server), and counts the changes on their way. */
export function watchServer() {
  const plain = window.fetch.bind(window)
  window.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href)
    if (url.origin !== location.origin) return plain(input, init)
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    const change = method !== 'GET' && method !== 'HEAD'
    if (change) saving++
    const sent = Date.now()
    // (After a quiet spell, or the first since the page opened: it may be waking.)
    if (!SLOW.test(url.pathname) && sent - answeredAt > QUIET_MS && !timer) {
      timer = setTimeout(() => { timer = undefined; if (answeredAt < sent) set(true) }, answeredAt ? LATER_AFTER_MS : FIRST_AFTER_MS)
    }
    // (A failure is an answer too: the screen that asked shows it.)
    const done = () => {
      if (change) saving--
      answeredAt = Date.now()
      clearTimeout(timer)
      timer = undefined
      set(false)
    }
    const job = plain(input, init)
    // (A proxy's page while the server starts isn't the server answering: still waking.)
    const starting = (res: Response) => res.status >= 502 && res.status <= 504 && (res.headers.get('content-type') ?? '').includes('text/html')
    job.then(res => {
      if (!starting(res)) return done()
      if (change) saving--
      timer ??= setTimeout(() => { timer = undefined; set(true) }, 0)
    }, done)
    return job
  }
}
