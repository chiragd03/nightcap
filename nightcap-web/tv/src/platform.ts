// The TV the app runs on: Samsung (Tizen), LG (webOS), or a desktop browser while developing.
// The app is opened by a launcher installed on the TV, which passes what
// it knows about the TV in the address's #… (the device's name and id, and its own address, to go
// back to for another server); it's kept here (localStorage) for later launches.
//
// The launcher also keeps every server this TV has joined (as the Android TV does), and passes them
// here: Connect shows them, one press to switch. Each server's app has its own storage, so its own
// key: switching is the launcher opening that server. What changes here (this household's name, or
// leaving it) goes back to the launcher with the next hand-off (handOff).

import * as store from './store'

declare global {
  interface Window {
    tizen?: {
      application: { getCurrentApplication(): { exit(): void } }
      tvinputdevice?: { registerKey(name: string): void; getSupportedKeys(): { name: string; code: number }[] }
    }
    webOS?: { platformBack?: () => void }
    PalmSystem?: unknown
  }
}

export type Kind = 'tizen' | 'webos' | 'browser'

export const kind: Kind = window.tizen ? 'tizen' : window.webOS || window.PalmSystem || /Web0S|webOS/.test(navigator.userAgent) ? 'webos' : 'browser'

/** A server this TV has joined, as the launcher keeps it: its address and the household's name. */
export type Saved = { url: string; household?: string }

type Launch = {
  name?: string; install?: string; platform?: string; launcher?: string; code?: string
  /** Every server this TV has joined (this one too, if it has). */
  servers?: Saved[]
  // Once each (taken): leave this household then go [back] to that server; a [status] to show on
  // Connect; [unreachable]: a server that couldn't be reached to leave it.
  leave?: string; back?: string; status?: string; unreachable?: string
}
const LAUNCH = 'nightcap.tv.launch'

function fromLaunch(): Launch {
  const m = location.hash.match(/(?:^#|&)nc=([^&]*)/)
  if (m) {
    try {
      const got = JSON.parse(decodeURIComponent(m[1])) as Launch
      localStorage.setItem(LAUNCH, JSON.stringify(got))
      // (Out of the address bar and history: it's read once.)
      history.replaceState(null, '', location.pathname + location.search)
      return got
    } catch { /* a broken #nc=: what was kept before */ }
  }
  try { return JSON.parse(localStorage.getItem(LAUNCH) ?? '{}') as Launch } catch { return {} }
}
const launch = fromLaunch()

/** What the launcher passed for this start only: taken once. */
function take(key: 'code' | 'leave' | 'back' | 'status' | 'unreachable') {
  const value = launch[key]?.trim()
  if (!value) return undefined
  delete launch[key]
  try { localStorage.setItem(LAUNCH, JSON.stringify(launch)) } catch { /* storage blocked */ }
  return value
}

/** A join code from the invite link the launcher was given (after its #): used once. */
export const launchCode = {
  take() {
    return take('code')?.toUpperCase().slice(0, 8) ?? null
  },
}

/** Why the launcher opened this app, if not just to use it: to leave this household, then go [back];
 * or to show Connect with a [status], or with a server that couldn't be reached to leave it. */
export function arrival() {
  return { leave: !!take('leave'), back: take('back'), status: take('status'), unreachable: take('unreachable') }
}

// Servers forgotten here (couldn't be reached to leave them), until the launcher has been told.
const FORGOTTEN = 'nightcap.tv.forgotten'
function forgotten(): string[] {
  try { return JSON.parse(localStorage.getItem(FORGOTTEN) ?? '[]') as string[] } catch { return [] }
}
// (Told: what the launcher passed no longer has them.)
try { localStorage.setItem(FORGOTTEN, JSON.stringify(forgotten().filter(u => launch.servers?.some(s => s.url === u)))) } catch { /* storage blocked */ }

/** This server's address, as the launcher keeps it. */
export const here = location.origin

/** The other servers this TV has joined. */
export function otherServers(): Saved[] {
  const gone = forgotten()
  return (launch.servers ?? []).filter(s => s.url !== here && gone.indexOf(s.url) < 0)
}

/** A saved server, on this TV only (it couldn't be reached to leave it). */
export function forgetServer(url: string) {
  try { localStorage.setItem(FORGOTTEN, JSON.stringify([url, ...forgotten()])) } catch { /* storage blocked */ }
}

/** A home address: a .local name, or a private or loopback IPv4 address (the launcher's rule). */
function atHome(host: string) {
  if (/\.local$/i.test(host)) return true
  const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (!m) return false
  const a = +m[1], b = +m[2]
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

/** Where [url] is, as people read it: "Home network · 192.168.1.20:7171", "Internet · nightcap" (for nightcap.example.com: its first part). */
export function where(url: string) {
  const host = url.replace(/^https?:\/\//, '')
  if (atHome(host.split(':')[0])) return `Home network · ${host}`
  const first = host.split('.')[0].split(':')[0]
  return `Internet · ${first.length > 20 ? `${first.slice(0, 18)}…` : first}`
}

/** The launcher's own address: where "another server" goes. None in a desktop browser. */
export const launcherUrl = launch.launcher

/** The TV's name, for the household's Devices page (60 characters at most). */
export function deviceName() {
  const name = launch.name?.trim()
  if (name) return name.slice(0, 60)
  return kind === 'tizen' ? 'Samsung TV' : kind === 'webos' ? 'LG TV' : 'TV (browser)'
}

/** An id this TV keeps, so joining again replaces its own entry on the Devices page (8 to 100
 * characters). From the launcher (Samsung's DUID; LG's kept id), else one made and kept here. */
export function installId() {
  if (launch.install && launch.install.length >= 8) return launch.install.slice(0, 100)
  const KEY = 'nightcap.tv.install'
  let id = localStorage.getItem(KEY)
  if (!id) {
    id = `${kind}:${Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('')}`
    localStorage.setItem(KEY, id)
  }
  return id
}

/** Closes the app (Back where there's nothing to go back to). */
export function exit() {
  try {
    if (window.tizen) return window.tizen.application.getCurrentApplication().exit()
    if (kind === 'webos') return window.webOS?.platformBack ? window.webOS.platformBack() : window.close()
  } catch { /* nothing to do in a browser */ }
}

/** To the launcher, with what's changed here: this server's household (or that this TV has left it),
 * and the servers forgotten here. [what]: change (its Connect screen), or to (open that server). */
function handOff(what: Record<string, string>) {
  if (!launcherUrl) return
  const name = store.household.get()
  const tell: Record<string, string> = { ...what, me: here, ...(store.ready() ? { household: name ?? '' } : { left: '1' }) }
  const gone = forgotten()
  if (gone.length) tell.forget = gone.join(',')
  location.href = `${launcherUrl.split('#')[0]}#${Object.keys(tell).map(k => `${k}=${encodeURIComponent(tell[k])}`).join('&')}`
}

/** Back to the launcher, to connect to another server. */
export const toLauncher = () => handOff({ change: '1' })

/** To a server this TV has joined: the launcher opens it, with its own key. */
export const switchTo = (url: string) => handOff({ to: url })

/** Leaves the household on a server this TV has joined (not the one in use): the launcher opens it to
 * leave, and comes back here, to Connect, with how that went. */
export const leaveThere = (url: string) => handOff({ to: url, leave: '1' })

/** Back to [url] after leaving here, its Connect screen saying [status]. */
export const backTo = (url: string, status: string) => handOff({ to: url, status })

/** Samsung only delivers the media keys to apps that ask for them. */
export function registerKeys() {
  const input = window.tizen?.tvinputdevice
  if (!input) return
  const want = ['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop', 'MediaFastForward', 'MediaRewind', 'MediaTrackPrevious', 'MediaTrackNext', 'ChannelUp', 'ChannelDown']
  const supported = new Set(input.getSupportedKeys().map(k => k.name))
  for (const name of want) if (supported.has(name)) { try { input.registerKey(name) } catch { /* not on this model */ } }
}
