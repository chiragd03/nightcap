// A new version of the app, after a deploy. The service worker (sw.template.js) is written for each
// build; when a newer one takes over while this page runs an older build, the page offers "A new
// version is ready" with Reload, or reloads by itself when nobody would notice: a browsing page
// (Home, Shows, Movies, a title, Search), the tab hidden, nothing open over it and nothing being saved.

import { useSyncExternalStore } from 'react'
import { writing } from './waking'

/** This build's id (appWorker.ts puts it in the page; not in the code, so a file that hasn't changed
 * keeps its name from one build to the next). */
export const BUILD = document.querySelector<HTMLMetaElement>('meta[name="nightcap-build"]')?.content ?? 'dev'

let ready = false
const listeners = new Set<() => void>()
const set = (v: boolean) => { ready = v; listeners.forEach(l => l()) }

/** Whether a newer version has taken over (the page shows "A new version is ready"). */
export const useNewVersion = () =>
  useSyncExternalStore(l => { listeners.add(l); return () => { listeners.delete(l) } }, () => ready)

/** Where a reload loses nothing: the address says everything on the page. */
const BROWSING = /^\/app\/(|shows|movies|search|title\/[^/]+\/[^/]+|person\/[^/]+|browse\/[^/]+)\/?$/

/** A player's page is open (the film or Live TV's): nothing drawn over it. */
export const playerOpen = () => /^\/app\/(watch|live\/watch)\//.test(location.pathname)

let players = 0
/** Marks a player as drawn while [on] (the film or Live TV's): the page isn't reloaded under it. */
export const playerShown = () => { players++; return () => { players-- } }
/** A player is drawn (not just its page's address). */
export const playing = () => players > 0

const quiet = () =>
  document.visibilityState === 'hidden' && BROWSING.test(location.pathname) && writing() === 0 &&
  !document.querySelector('[role="dialog"], [role="menu"], form.pin')

function reloadIfQuiet() {
  if (!ready || !quiet()) return
  // (Back where it was after the reload: components/Scroll.)
  try { sessionStorage.setItem('nightcap.scroll', JSON.stringify({ at: location.pathname + location.search, y: window.scrollY })) } catch { /* storage blocked */ }
  location.reload()
}

/** Where the page was scrolled to before reloading for a new version, if it's this page. */
export function takeScroll(): number | undefined {
  try {
    const kept = JSON.parse(sessionStorage.getItem('nightcap.scroll') ?? 'null') as { at: string; y: number } | null
    sessionStorage.removeItem('nightcap.scroll')
    return kept && kept.at === location.pathname + location.search ? kept.y : undefined
  } catch { return undefined }
}

let registration: ServiceWorkerRegistration | undefined
let checkedAt = 0
/** Asks the server whether there's a new version (a new sw.js): an open tab hears of a deploy
 * without waiting for the browser's own check (a day). */
function checkForNew(force = false) {
  if (!registration || (!force && Date.now() - checkedAt < 60_000)) return Promise.resolve()
  checkedAt = Date.now()
  return registration.update().catch(() => {})
}

/** Registers the worker (after the page has loaded, so it never competes with it). */
export function watchVersions() {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return
  const sw = navigator.serviceWorker
  const say = (answer = false) => sw.controller?.postMessage({ type: 'running', build: BUILD, answer })
  sw.addEventListener('message', e => {
    if (e.data?.type === 'running?') say(true)
    // (Only a newer build: during a rollout an older revision's worker can come back.)
    if (e.data?.type === 'activated' && e.data.build > BUILD) { set(true); reloadIfQuiet() }
  })
  sw.addEventListener('controllerchange', () => say())
  document.addEventListener('visibilitychange', () => {
    reloadIfQuiet()
    if (document.visibilityState === 'visible') checkForNew()
  })
  // (Not on a timer: a tab left open would wake the sleeping server for it.)
  const register = () => {
    sw.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL }).then(r => { registration = r }, () => {})
    say()
  }
  if (document.readyState === 'complete') register()
  else addEventListener('load', register, { once: true })
}

/** A screen's code that can't be fetched (a deploy took it away, or no connection). */
export const isChunkError = (e: unknown) =>
  e instanceof Error && /dynamically imported module|Importing a module script failed|error loading dynamically imported|Unable to preload/i.test(e.message)

/** Reloads to fetch the new version's screens, once per build, never under a player. A new version
 * on its way (being installed) is waited for first, so the reload gets it, not this one again. */
export async function reloadForChunks() {
  if (playing()) return
  try {
    const key = 'nightcap.reloaded.' + BUILD
    if (sessionStorage.getItem(key)) return
    sessionStorage.setItem(key, '1')
  } catch { return }
  await checkForNew(true)
  const coming = registration?.installing ?? registration?.waiting
  if (coming) {
    await new Promise(done => {
      navigator.serviceWorker.addEventListener('controllerchange', done, { once: true })
      setTimeout(done, 10_000)
    })
  }
  location.reload()
}
