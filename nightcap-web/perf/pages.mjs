// The web app's pages measured in Chrome over CDP: LCP, CLS and its shifts,
// long tasks, bytes, and scrolling and hovering Home. Medians of RUNS runs.
//
// Serve a build first (npm run build && npx vite preview --port 4173, with NIGHTCAP_SERVER set to the
// server to talk to), then:
//   NIGHTCAP_DEVICE_KEY_FILE=… NIGHTCAP_PROFILE=… node pages.mjs [repeat|first]
// repeat (default): each run opens the page once in a fresh browser, then measures a second open (the
//   service worker and the browser's cache warm).
// first: each run is a fresh browser, measured on its first open.
// Settings: BASE (default http://localhost:4173/app), RUNS (5), CPU (4: the CPU slowed that many
// times), NET (fast4g | none), PHONE (1: a 390 x 844 phone screen), PAGES (comma list of names below).
// Only GET requests reach the server: anything else is answered 503 here, so nothing is changed.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const MODE = process.argv[2] ?? 'repeat'
const BASE = process.env.BASE ?? 'http://localhost:4173/app'
const RUNS = +(process.env.RUNS ?? 5)
const CPU = +(process.env.CPU ?? 4)
const NET = process.env.NET ?? 'fast4g'
const PHONE = process.env.PHONE === '1'
const KEY = fs.readFileSync(process.env.NIGHTCAP_DEVICE_KEY_FILE, 'utf8').trim()
const PROFILE = process.env.NIGHTCAP_PROFILE
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = 9400 + Math.floor(Math.random() * 500)

// Each page: its path, and what shows once its data is in.
const ALL = {
  home: { path: '/', sel: '.row .card', scroll: true, hover: true },
  shows: { path: '/shows', sel: '.row .card' },
  movies: { path: '/movies', sel: '.row .card' },
  title: { path: '/title/movie/tt1375666', sel: '.title-page .title-top' },
  search: { path: '/search?q=nolan', sel: '.card' },
  settings: { path: '/settings', sel: '.st-big' },
}
const PAGES = (process.env.PAGES ?? Object.keys(ALL).join(',')).split(',').map((n) => ({ name: n, ...ALL[n] }))

// (DevTools' "Fast 4G".)
const FAST4G = { offline: false, latency: 60, downloadThroughput: (9 * 1024 * 1024) / 8, uploadThroughput: (1.5 * 1024 * 1024) / 8 }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const median = (xs) => { const s = xs.filter((x) => x != null).sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null }
const p95 = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] : 0 }

const OBS = `
localStorage.setItem('nightcap.device', ${JSON.stringify(KEY)});
${PROFILE ? `localStorage.setItem('nightcap.profile', ${JSON.stringify(PROFILE)});` : ''}
window.__m = { cls: 0, shifts: [], long: [], lcp: 0, lcpEl: '', fcp: 0, events: [] };
new PerformanceObserver(l => l.getEntries().forEach(e => { if (!e.hadRecentInput) { __m.cls += e.value; __m.shifts.push([Math.round(e.startTime), +e.value.toFixed(4), (e.sources || []).map(s => s.node ? (s.node.className || s.node.nodeName) + '' : '?').slice(0, 3).join('|')]) } })).observe({ type: 'layout-shift', buffered: true });
new PerformanceObserver(l => l.getEntries().forEach(e => __m.long.push([Math.round(e.startTime), Math.round(e.duration)]))).observe({ type: 'longtask', buffered: true });
new PerformanceObserver(l => l.getEntries().forEach(e => { __m.lcp = Math.round(e.startTime); __m.lcpEl = e.element ? (e.element.className || e.element.nodeName) + '' : e.url })).observe({ type: 'largest-contentful-paint', buffered: true });
new PerformanceObserver(l => l.getEntries().forEach(e => { if (e.name === 'first-contentful-paint') __m.fcp = Math.round(e.startTime) })).observe({ type: 'paint', buffered: true });
new PerformanceObserver(l => l.getEntries().forEach(e => __m.events.push([e.name, Math.round(e.duration)]))).observe({ type: 'event', buffered: true, durationThreshold: 16 });
`

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightcap-perf-'))
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}`, '--no-first-run', '--mute-audio', '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' })
const done = () => { chrome.kill(); try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }) } catch {} }
process.on('exit', done)

let ver
for (let i = 0; i < 50 && !ver; i++) { await sleep(200); ver = await fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) => r.json()).catch(() => null) }
const ws = new WebSocket(ver.webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
let id = 0
const pending = new Map()
const handlers = []
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id) } else handlers.forEach((h) => h(d)) }
const send = (method, params = {}, sessionId) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params, sessionId })) })

async function tab(ctx) {
  const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank', browserContextId: ctx })
  const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true })
  const s = (m, p) => send(m, p, sessionId)
  await s('Page.enable'); await s('Network.enable'); await s('Runtime.enable')
  if (CPU > 1) await s('Emulation.setCPUThrottlingRate', { rate: CPU })
  if (NET === 'fast4g') await s('Network.emulateNetworkConditions', FAST4G)
  if (PHONE) { await s('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true }); await s('Emulation.setTouchEmulationEnabled', { enabled: true }) }
  await s('Page.addScriptToEvaluateOnNewDocument', { source: OBS })
  await s('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] })
  const reqs = new Map()
  const blocked = []
  handlers.push((d) => {
    if (d.sessionId !== sessionId) return
    const p = d.params
    if (d.method === 'Fetch.requestPaused') {
      if (p.request.method !== 'GET') { blocked.push(p.request.method + ' ' + new URL(p.request.url).pathname); s('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 503, body: btoa('{"error":"blocked by perf"}') }) }
      else s('Fetch.continueRequest', { requestId: p.requestId })
    }
    if (d.method === 'Network.requestWillBeSent') reqs.set(p.requestId, { url: p.request.url, type: p.type })
    if (d.method === 'Network.responseReceived') { const q = reqs.get(p.requestId); if (q) { q.sw = p.response.fromServiceWorker; q.type = p.type } }
    if (d.method === 'Network.loadingFinished') { const q = reqs.get(p.requestId); if (q) q.bytes = p.encodedDataLength }
  })
  const ev = async (expr) => (await s('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result.result?.value
  return { s, ev, reqs, blocked, close: () => send('Target.closeTarget', { targetId }) }
}

async function load(t, page) {
  t.reqs.clear()
  await t.s('Page.navigate', { url: BASE + page.path })
  let ready = null
  for (let i = 0; i < 300 && ready == null; i++) { await sleep(100); if (await t.ev(`!!document.querySelector(${JSON.stringify(page.sel)})`)) ready = await t.ev('Math.round(performance.now())') }
  await sleep(3000)
  return ready
}

async function measure(page) {
  const { result: { browserContextId: ctx } } = await send('Target.createBrowserContext')
  const t = await tab(ctx)
  try {
    if (MODE === 'repeat') {
      await load(t, page)
      // (A repeat visit comes after the app's copy is kept: the worker's installing done.)
      await t.ev(`Promise.race([navigator.serviceWorker?.ready.then(() => new Promise(r => { const ok = () => navigator.serviceWorker.controller ? r() : setTimeout(ok, 100); ok() })), new Promise(r => setTimeout(r, 20000))])`)
    }
    const ready = await load(t, page)
    const out = { ready, ...(await t.ev(`({ nav: (n => [n.workerStart, n.fetchStart, n.responseStart, n.responseEnd, n.domInteractive].map(Math.round))(performance.getEntriesByType('navigation')[0]), controlled: !!navigator.serviceWorker?.controller, fcp: __m.fcp, lcp: __m.lcp, lcpEl: __m.lcpEl, cls: +__m.cls.toFixed(4), shifts: __m.shifts.slice(0, 6), long: __m.long.map(l => l[1]) })`)) }
    if (page.scroll) {
      out.scroll = await t.ev(`new Promise(res => { const before = __m.long.length; let last = performance.now(); const start = last, frames = []; const H = document.documentElement.scrollHeight - innerHeight;
        (function f(now) { frames.push(now - last); last = now; const p = (now - start) / 4000; scrollTo(0, H * Math.min(1, p)); if (p < 1) requestAnimationFrame(f); else res({ over50: frames.filter(x => x > 50).length, worst: Math.round(Math.max(...frames)), long: __m.long.slice(before).map(l => l[1]) }) })(start) })`)
    }
    if (page.hover) {
      const pts = await t.ev(`(scrollTo(0, 0), [...document.querySelectorAll('.row .card')].slice(0, 24).map(c => { const r = c.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2] }).filter(p => p[1] > 0 && p[1] < innerHeight))`)
      await t.ev('window.__lb = __m.long.length; window.__eb = __m.events.length; 1')
      for (const [x, y] of pts) { await t.s('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }); await sleep(120) }
      out.hover = { long: await t.ev('__m.long.slice(__lb).map(l => l[1])'), slowest: await t.ev('Math.max(0, ...__m.events.slice(__eb).map(e => e[1]))') }
    }
    const all = [...t.reqs.values()]
    const kb = (f) => +(all.filter(f).reduce((a, r) => a + (r.bytes || 0), 0) / 1024).toFixed(1)
    Object.assign(out, { jsKB: kb((r) => r.type === 'Script'), cssKB: kb((r) => r.type === 'Stylesheet'), fontKB: kb((r) => r.type === 'Font'), imgKB: kb((r) => r.type === 'Image'), blocked: t.blocked.length })
    return out
  } finally {
    await t.close()
    await send('Target.disposeBrowserContext', { browserContextId: ctx })
  }
}

console.log(`${MODE} visit, ${RUNS} runs, CPU ${CPU}x, network ${NET}${PHONE ? ', phone' : ''}, ${BASE}`)
for (const page of PAGES) {
  const runs = []
  for (let i = 0; i < RUNS; i++) { try { runs.push(await measure(page)) } catch (e) { console.log(page.name, 'run failed:', e.message) } }
  const m = (k) => median(runs.map((r) => r[k]))
  const longs = runs.flatMap((r) => r.long)
  const row = { page: page.name, ready: m('ready'), fcp: m('fcp'), lcp: m('lcp'), cls: m('cls'), longP95: p95(longs), longMax: Math.max(0, ...longs), jsKB: m('jsKB'), cssKB: m('cssKB'), fontKB: m('fontKB'), imgKB: m('imgKB') }
  if (page.scroll) Object.assign(row, { scrollOver50: median(runs.map((r) => r.scroll?.over50)), scrollLongMax: Math.max(0, ...runs.flatMap((r) => r.scroll?.long ?? [])) })
  if (page.hover) Object.assign(row, { hoverLongMax: Math.max(0, ...runs.flatMap((r) => r.hover?.long ?? [])), hoverSlowestEvent: median(runs.map((r) => r.hover?.slowest)) })
  console.log(JSON.stringify(row))
  if (process.env.DEBUG) runs.forEach(r => console.log('  nav', JSON.stringify(r.nav), 'controlled', r.controlled, 'fcp', r.fcp))
  const worst = runs.reduce((a, r) => (r.cls > (a?.cls ?? -1) ? r : a), null)
  if (worst?.shifts?.length) console.log('  shifts (worst run):', JSON.stringify(worst.shifts))
  if (worst) console.log('  LCP element:', worst.lcpEl)
}
ws.close()
process.exit(0)
