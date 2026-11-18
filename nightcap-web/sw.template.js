// Nightcap's copy of the web app kept in the browser (a service worker), so opening it is quick and
// never a blank screen while the server is asleep (Cloud Run takes a few seconds to start it after a
// quiet spell). Written for each build by appWorker.ts, which fills in BUILD, FILES and KEEP; it
// changes with every deploy, so the browser installs the new one.
//
// - Installing: the whole build (its page, screens, styles, fonts, the brand mark) is kept in this
//   build's own cache before the worker counts. Files that haven't changed since the last build are
//   copied over from its cache, not downloaded again.
// - A page of the app (any address under /app/: it's one page): from the server if it answers within
//   WAIT_MS, else this build's kept page. (The app shows "Waking up" until the server answers.)
// - The built files (/app/assets/): from any kept build's cache (an open tab of an older build still
//   finds its own), else the server. The player's decoders and hls.js are kept the first time.
// - The brand images and avatars: the kept copy, refreshed in the background.
// - Everything else (the server's answers, playback, other sites, and the TV app at /app/tv/, which is
//   another app): not touched.
// - Old builds' caches go once no open tab says it's running that build.

const BUILD = __BUILD__
/** What's kept on installing. */
const FILES = __FILES__
/** Every file of this build: one not kept on installing (a decoder) is kept when first fetched. */
const KEEP = new Set(__KEEP__)

const PREFIX = 'nightcap-app-'
const CACHE = PREFIX + BUILD
const BASE = '/app/'
const TV = '/app/tv/'
const WAIT_MS = 400
const BUILT = /^\/app\/assets\//
const STATIC = /^\/app\/(fonts|brand|avatars)\//

const isPage = (res) => (res.headers.get('content-type') || '').includes('text/html')

self.addEventListener('install', (e) => {
  e.waitUntil(install().then(() => self.skipWaiting()))
})

async function install() {
  const cache = await caches.open(CACHE)
  const older = (await caches.keys()).filter((k) => k.startsWith(PREFIX) && k !== CACHE)
  await Promise.all(FILES.map(async (path) => {
    if (await cache.match(path, ANY)) return
    if (BUILT.test(path)) {
      // (A built file's name changes when its contents do: the same name is the same file.)
      for (const k of older) {
        const kept = await (await caches.open(k)).match(path, ANY)
        if (kept) return cache.put(path, kept)
      }
    }
    const res = await fetch(path, { cache: 'reload' })
    if (!res.ok || (path !== BASE && isPage(res))) throw new Error(`${path}: ${res.status}`)
    // (The page must be this build's: a deploy in between would bring the next one's.)
    if (path === BASE && !(await res.clone().text()).includes(BUILD)) throw new Error('another build')
    await cache.put(path, res)
  }))
}

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    await self.registration.navigationPreload?.enable()
    await self.clients.claim()
    // Every tab is told: one on an older build offers the new version.
    for (const c of await self.clients.matchAll({ type: 'window' })) c.postMessage({ type: 'activated', build: BUILD })
  })().then(() => {
    // (Not part of activating: pages wait for that to finish, and this waits for the tabs' answers.)
    cleanUp()
  }))
})

// Each tab says which build it's running (when it opens, and when asked).
const running = new Map()
let asked
self.addEventListener('message', (e) => {
  if (e.data?.type !== 'running' || !e.source) return
  running.set(e.source.id, e.data.build)
  // (A tab that has just opened: an older build's cache may have no tab left. Not an answer to the
  // question below, which would ask again.)
  if (!e.data.answer) e.waitUntil(caches.keys().then((ks) => ks.some((k) => k.startsWith(PREFIX) && k !== CACHE && older(k)) && cleanUp()))
})

/** Whether a cache is an older build's (ids are times: a later build's is greater). A cache
 * named nightcap-app-v1 is older too. */
const older = (k) => {
  const b = k.slice(PREFIX.length)
  return !/^[0-9a-z]{8}[0-9a-f]{6}$/.test(b) || b < BUILD
}

/** Every tab is asked which build it runs; a few seconds later, older builds' caches no tab runs go.
 * (Only by the worker in charge, and never a newer build's: that one may be installing.) */
function cleanUp() {
  asked ??= (async () => {
    running.clear()
    const tabs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const c of tabs) c.postMessage({ type: 'running?' })
    await new Promise((r) => setTimeout(r, 5000))
    const open = new Set((await self.clients.matchAll({ type: 'window', includeUncontrolled: true })).map((c) => c.id))
    const used = new Set([...running].filter(([id]) => open.has(id)).map(([, b]) => PREFIX + b))
    if (self.serviceWorker && self.registration.active !== self.serviceWorker) return
    for (const k of await caches.keys()) {
      if (k.startsWith(PREFIX) && k !== CACHE && older(k) && !used.has(k)) await caches.delete(k)
    }
  })().finally(() => { asked = undefined })
  return asked
}

self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin || !url.pathname.startsWith(BASE) || url.pathname.startsWith(TV) || url.pathname === TV.slice(0, -1)) return
  if (req.mode === 'navigate') e.respondWith(page(e))
  else if (BUILT.test(url.pathname)) e.respondWith(built(req, url.pathname))
  else if (STATIC.test(url.pathname)) e.respondWith(fresh(req, e))
})

async function page(e) {
  const fromServer = Promise.resolve(e.preloadResponse)
    .then((r) => r || fetch(e.request))
    .then((res) => { if (!res.ok || !isPage(res)) throw new Error(String(res.status)); return res })
  fromServer.catch(() => {})
  const kept = caches.open(CACHE).then((c) => c.match(BASE, ANY))
  const late = new Promise((r) => setTimeout(r, WAIT_MS))
  try {
    return await Promise.race([fromServer, late.then(() => Promise.reject(new Error('late')))])
  } catch {
    return (await kept) || fromServer
  }
}

// (Kept copies are matched by address alone: a module's import sends an Origin header that the kept
// copy's request didn't have, and the server's Vary would otherwise make it miss.)
const ANY = { ignoreVary: true }

async function built(req, path) {
  const kept = await caches.match(req, ANY)
  if (kept) return kept
  const res = await fetch(req)
  // (A file the server doesn't have comes back as the app's page: not a script. A proxy's error page
  // while the server starts goes through as the error it is.)
  if (res.ok && isPage(res)) return new Response('', { status: 404 })
  if (res.ok && KEEP.has(path)) await (await caches.open(CACHE)).put(req, res.clone())
  return res
}

async function fresh(req, e) {
  const cache = await caches.open(CACHE)
  const kept = await cache.match(req, ANY)
  const fromServer = fetch(req).then(async (res) => {
    if (res.ok && !isPage(res)) await cache.put(req, res.clone())
    return res
  })
  if (!kept) return fromServer
  e.waitUntil(fromServer.catch(() => {}))
  return kept
}
