// Nightcap's launcher on Samsung (Tizen) and LG (webOS) TVs. The TV app itself is served by the
// household's Nightcap server (at /app/tv/), so it's the server's version
// that runs and updates come with the server. This page only knows which server: it's asked once
// (the Android TV's address rules), kept, and opened at every start
// with "Waking up" while a sleeping server starts. It tells the app the TV's name and id.
//
// Every server this TV has joined is kept too (as the Android TV does), and passed to the app, whose
// Connect screen offers them (SWITCH TO): each server's app has its own storage, so its own key, and
// switching is this page opening that server. The app hands off back here with what's changed on
// its side (#me=its address, &household=its name or &left=1, &forget=servers forgotten there) and
// what to do: change (this Connect screen), or to=a server to open (&leave=1: to leave its household
// there, then come back to [me]; &status=what to show there).
'use strict'

// 1rem = 1 dp of a 960 x 540 dp screen, as large as fits the window.
function fit() { document.documentElement.style.fontSize = Math.min(innerWidth / 960, innerHeight / 540) + 'px' }
fit()
window.addEventListener('resize', fit)

var SAVED = 'nightcap.launcher.server'
var SERVERS = 'nightcap.launcher.servers'
var WAKING_AFTER_MS = 1500
var PROBE_TIMEOUT_MS = 90000
var ICONS = { wifi: 'M138,204a10,10,0,1,1-10-10A10,10,0,0,1,138,204ZM235.81,88.55a170,170,0,0,0-215.62,0,6,6,0,1,0,7.62,9.27,158,158,0,0,1,200.38,0,6,6,0,1,0,7.62-9.27Zm-32.08,35.79a122,122,0,0,0-151.46,0,6,6,0,0,0,7.46,9.41,110,110,0,0,1,136.54,0A6,6,0,0,0,200,135a6,6,0,0,0,3.73-10.7Zm-32.2,35.81a74,74,0,0,0-87.06,0,6,6,0,0,0,7.06,9.7,62,62,0,0,1,72.94,0,6,6,0,0,0,8.38-1.32A6,6,0,0,0,171.53,160.15Z', globe: 'M128,26A102,102,0,1,0,230,128,102.12,102.12,0,0,0,128,26Zm89.8,96H173.89c-1.54-40.77-18.48-68.23-30.43-82.67A90.19,90.19,0,0,1,217.8,122ZM128,215.83a110,110,0,0,1-15.19-19.45A128.37,128.37,0,0,1,94.13,134h67.74a128.37,128.37,0,0,1-18.68,62.38A110,110,0,0,1,128,215.83ZM94.13,122a128.37,128.37,0,0,1,18.68-62.38A110,110,0,0,1,128,40.17a110,110,0,0,1,15.19,19.45A128.37,128.37,0,0,1,161.87,122Zm18.41-82.67c-12,14.44-28.89,41.9-30.43,82.67H38.2A90.19,90.19,0,0,1,112.54,39.33ZM38.2,134H82.11c1.54,40.77,18.48,68.23,30.43,82.67A90.19,90.19,0,0,1,38.2,134Zm105.26,82.67c11.95-14.44,28.89-41.9,30.43-82.67H217.8A90.19,90.19,0,0,1,143.46,216.67Z' }

var $ = function (id) { return document.getElementById(id) }
var saved = function () { try { return localStorage.getItem(SAVED) } catch (e) { return null } }
var save = function (url) { try { localStorage.setItem(SAVED, url) } catch (e) { /* storage blocked */ } }
var forget = function () { try { localStorage.removeItem(SAVED) } catch (e) { /* storage blocked */ } }

// ---------- The servers this TV has joined ----------

/** [{ url, household }], the last told first. */
function servers() {
  try { var list = JSON.parse(localStorage.getItem(SERVERS) || '[]'); return Array.isArray(list) ? list : [] } catch (e) { return [] }
}
function keepServers(list) { try { localStorage.setItem(SERVERS, JSON.stringify(list)) } catch (e) { /* storage blocked */ } }
function rememberServer(url, household) {
  keepServers([{ url: url, household: household }].concat(servers().filter(function (s) { return s.url !== url })))
}
function forgetServer(url) { keepServers(servers().filter(function (s) { return s.url !== url })) }

/** What the app handed off with, after the # (see the top). */
function handedOff() {
  var got = {}
  location.hash.replace(/^#/, '').split('&').forEach(function (part) {
    if (!part) return
    var at = part.indexOf('=')
    try { got[at < 0 ? part : part.slice(0, at)] = at < 0 ? '1' : decodeURIComponent(part.slice(at + 1)) } catch (e) { /* a broken one */ }
  })
  if (got.me) {
    if (got.left) forgetServer(got.me)
    else if (got.household != null) rememberServer(got.me, got.household)
  }
  if (got.forget) got.forget.split(',').forEach(forgetServer)
  return got
}

// ---------- The TV ----------

var platform = window.tizen ? 'tizen' : (window.PalmSystem || /Web0S|webOS/.test(navigator.userAgent)) ? 'webos' : 'browser'

function deviceInfo() {
  var name = platform === 'tizen' ? 'Samsung TV' : platform === 'webos' ? 'LG TV' : 'TV (browser)'
  var install = null
  try {
    if (window.webapis && webapis.productinfo) {
      name = webapis.productinfo.getRealModel() || webapis.productinfo.getModel() || name
      var duid = webapis.productinfo.getDuid()
      if (duid) install = 'tizen:' + duid
    }
  } catch (e) { /* not on this model */ }
  if (!install) {
    try {
      install = localStorage.getItem('nightcap.launcher.install')
      if (!install) {
        var bytes = new Uint8Array(16)
        crypto.getRandomValues(bytes)
        install = platform + ':' + Array.prototype.map.call(bytes, function (b) { return ('0' + b.toString(16)).slice(-2) }).join('')
        localStorage.setItem('nightcap.launcher.install', install)
      }
    } catch (e) { install = undefined }
  }
  return { name: String(name).slice(0, 60), install: install, platform: platform }
}

function exitApp() {
  try {
    if (window.tizen) return tizen.application.getCurrentApplication().exit()
    if (window.webOS && webOS.platformBack) return webOS.platformBack()
    if (window.PalmSystem && PalmSystem.platformBack) return PalmSystem.platformBack()
    window.close()
  } catch (e) { /* a browser: nothing to close */ }
}

function registerKeys() {
  try {
    var input = window.tizen && tizen.tvinputdevice
    if (!input) return
    var supported = input.getSupportedKeys().map(function (k) { return k.name })
    ;['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop', 'MediaFastForward', 'MediaRewind'].forEach(function (k) {
      if (supported.indexOf(k) >= 0) input.registerKey(k)
    })
  } catch (e) { /* not on this model */ }
}

// ---------- Addresses ----------

/** A home address: a .local name, or a private or loopback IPv4 address. */
function atHome(host) {
  if (/\.local$/i.test(host)) return true
  var m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (!m) return false
  var a = +m[1], b = +m[2]
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

/** What was typed, as { url, code } or { error }. */
function addressFrom(typed) {
  var t = typed.trim()
  if (!t) return { error: 'Type the address you were given.' }
  var code = null
  var hash = t.indexOf('#')
  if (hash >= 0) { code = t.slice(hash + 1).trim() || null; t = t.slice(0, hash) }
  var schemed = /^https?:\/\//i.test(t)
  var u
  try { u = new URL(schemed ? t : 'http://' + t) } catch (e) { return { error: "That doesn't look like an address. Check it and try again." } }
  if (!u.hostname || u.username || u.password) return { error: "That doesn't look like an address. Check it and try again." }
  var path = u.pathname.replace(/\/+$/, '')
  // An address, or an invite link to the server's web app (its join page, or any page of it).
  if (u.search || (path && !/^\/app(\/|$)/.test(path))) {
    return { error: "Short links can't be opened on the TV. Type the server's address, or its full invite link." }
  }
  var scheme = schemed ? u.protocol : atHome(u.hostname) ? 'http:' : 'https:'
  if (scheme === 'http:' && !atHome(u.hostname)) return { error: "That address isn't secure. Ask for its secure version." }
  return { url: scheme + '//' + u.host, code: code }
}

// ---------- Opening the server's TV app ----------

/** Whether [url] is a Nightcap server with the TV app, and awake: its probe.js, by a script tag
 * (a launcher may load a script from anywhere; reading an answer would need CORS). */
function probe(url, done) {
  var finished = false
  var finish = function (ok) {
    if (finished) return
    finished = true
    clearTimeout(timer)
    if (script.parentNode) script.parentNode.removeChild(script)
    done(ok)
  }
  window.nightcapTv = undefined
  var script = document.createElement('script')
  script.src = url + '/app/tv/probe.js?' + Date.now()
  script.onload = function () { finish(!!window.nightcapTv) }
  script.onerror = function () { finish(false) }
  var timer = setTimeout(function () { finish(false) }, PROBE_TIMEOUT_MS)
  document.head.appendChild(script)
}

/** Opens [url]'s TV app; [extra]: for this start only (leave, back, status, unreachable). */
function openApp(url, code, extra) {
  var info = deviceInfo()
  info.launcher = location.href.split('#')[0]
  info.servers = servers()
  if (code) info.code = code
  for (var k in extra || {}) if (extra[k]) info[k] = extra[k]
  save(url)
  registerKeys()
  location.href = url + '/app/tv/index.html#nc=' + encodeURIComponent(JSON.stringify(info))
}

var screen = 'connect'

/** At start: the server last used, with "Waking up" if it's slow to answer. [extra]: as openApp's. */
function openSaved(url, extra) {
  screen = 'opening'
  show('opening')
  $('opening-text').textContent = 'Opening Nightcap…'
  $('opening-sub').textContent = ''
  var waking = setTimeout(function () {
    $('opening-text').textContent = 'Waking up Nightcap…'
    $('opening-sub').textContent = 'After a quiet spell the server takes a few seconds to start.'
  }, WAKING_AFTER_MS)
  probe(url, function (ok) {
    clearTimeout(waking)
    if (screen !== 'opening') return
    if (ok) return openApp(url, null, extra)
    // (Asked to leave there from another server: back to that one, to forget it there or keep it.)
    if (extra && extra.leave && extra.back) return openSaved(extra.back, { unreachable: url })
    showConnect("Couldn't reach " + url.replace(/^https?:\/\//, '') + '. Try again, or type another address.', true)
  })
}

// ---------- The Connect screen ----------

function show(which) {
  $('opening').hidden = which !== 'opening'
  $('connect').hidden = which === 'opening'
}

function tile(label, name, sub, icon, onPick) {
  var b = document.createElement('button')
  b.className = 'tile f'
  b.innerHTML = '<span class="tile-top"><span class="eyebrow"></span><svg viewBox="0 0 256 256"><path fill="currentColor" d="' + ICONS[icon] + '"/></svg></span>' +
    '<span class="tile-name"></span><span class="tile-sub"></span>'
  b.querySelector('.eyebrow').textContent = label
  b.querySelector('.tile-name').textContent = name
  b.querySelector('.tile-sub').textContent = sub
  b.onclick = onPick
  return b
}

function showConnect(status, focusSaved) {
  screen = 'connect'
  show('connect')
  var row = $('tiles')
  row.innerHTML = ''
  var last = saved()
  var savedTile = null
  if (last) {
    savedTile = tile('Last server', last.replace(/^https?:\/\//, ''), 'Open it again', 'wifi', function () { openSaved(last) })
    row.appendChild(savedTile)
  }
  var other = tile(last ? 'Another server' : 'Your server', 'Type an address', 'At home or in the cloud', 'globe', openPanel)
  row.appendChild(other)
  $('status').textContent = status || ''
  // (A saved server can be forgotten: one that's gone for good, say. Down from the cards.)
  $('forget').hidden = !last
  ;(focusSaved && savedTile ? savedTile : other).focus()
}

$('forget').onclick = function () {
  var was = saved()
  forget()
  if (was) forgetServer(was)
  showConnect(was ? 'Forgot ' + was.replace(/^https?:\/\//, '') + '.' : '')
}

var opener = null
var busy = false

function openPanel() {
  opener = document.activeElement
  screen = 'panel'
  $('panel').hidden = false
  $('connect-body').className = 'connect-body behind'
  $('panel-status').textContent = ''
  var field = $('address')
  field.value = saved() ? saved().replace(/^https?:\/\//, '') : ''
  field.focus()
  field.select()
}

function closePanel() {
  screen = 'connect'
  $('panel').hidden = true
  $('connect-body').className = 'connect-body'
  if (opener) opener.focus()
}

function connect() {
  if (busy) return
  var got = addressFrom($('address').value)
  if (got.error) { $('panel-status').textContent = got.error; return }
  busy = true
  $('panel-status').textContent = 'Connecting…'
  probe(got.url, function (ok) {
    busy = false
    if (screen !== 'panel') return
    if (!ok) { $('panel-status').textContent = "Couldn't reach a Nightcap server there."; return }
    save(got.url)
    openApp(got.url, got.code)
  })
}

$('go').onclick = connect
$('cancel').onclick = closePanel

// ---------- The remote ----------

function keyOf(e) {
  var k = e.keyCode
  if (k === 37) return 'left'
  if (k === 38) return 'up'
  if (k === 39) return 'right'
  if (k === 40) return 'down'
  if (k === 13 || k === 65376) return 'ok'
  if (k === 10009 || k === 461 || k === 27) return 'back'
  return null
}

function focusables() {
  var scope = screen === 'panel' ? $('panel') : $('connect')
  // (Forget is reached with Down only, not as the next card.)
  return Array.prototype.slice.call(scope.querySelectorAll('.f')).filter(function (el) { return el.id !== 'forget' })
}

function step(by) {
  var list = focusables()
  var at = list.indexOf(document.activeElement)
  var next = list[Math.max(0, Math.min(list.length - 1, at + by))]
  if (next) next.focus()
}

// The TV's keyboard: OK in the field types (opens the keyboard) or, with it up, connects. Back
// that closes it leaves the field focused (webOS takes focus off it; it's put back).
var TV = !!(window.tizen || window.webOS || window.PalmSystem || /Web0S|webOS|Tizen/.test(navigator.userAgent))
var kbShown = false
var reopening = false
function keyboardUp() { return TV ? kbShown : true }
function keyboardHidden() {
  kbShown = false
  if (reopening) return
  setTimeout(function () {
    var a = document.activeElement
    if (screen === 'panel' && (!a || a === document.body)) $('address').focus()
  }, 0)
}
window.addEventListener('keyboardStateChange', function (e) { if (e.detail && e.detail.visibility) kbShown = true; else keyboardHidden() })
window.addEventListener('softkeyboardchange', function (e) { if (e.state === 'on') kbShown = true; else keyboardHidden() })
$('address').addEventListener('input', function () { kbShown = true })
$('address').addEventListener('blur', function (e) { if (!e.relatedTarget) keyboardHidden(); else kbShown = false })

document.addEventListener('keydown', function (e) {
  var key = keyOf(e)
  if (!key) return
  if (key === 'back') {
    e.preventDefault()
    if (e.repeat) return
    if (screen === 'panel') return closePanel()
    if (screen === 'opening') { screen = 'connect'; return showConnect() }
    return exitApp()
  }
  if (screen === 'opening') return
  var active = document.activeElement
  var field = $('address')
  if (screen === 'panel') {
    // The TV's keyboard closed by Back leaves nothing focused (webOS blurs the field).
    if (!active || !$('panel').contains(active)) {
      e.preventDefault()
      return key === 'up' ? field.focus() : $('go').focus()
    }
    if (active === field) {
      if (key === 'down') { e.preventDefault(); $('go').focus() }
      // (OK with the keyboard closed opens it again: the TV opens it when the field gains focus.)
      if (key === 'ok') {
        e.preventDefault()
        if (keyboardUp()) return connect()
        reopening = true
        field.blur()
        setTimeout(function () { reopening = false; field.focus(); field.setSelectionRange(field.value.length, field.value.length) }, 150)
      }
      return
    }
    if (key === 'ok') { e.preventDefault(); return active.click() }
    if (key === 'up') { e.preventDefault(); field.focus() }
    if (key === 'left') { e.preventDefault(); $('go').focus() }
    if (key === 'right') { e.preventDefault(); $('cancel').focus() }
    return
  }
  // OK presses what has focus, on the key going down (a remote may send nothing after it).
  if (key === 'ok' && active && active.classList.contains('f') && active !== field) { e.preventDefault(); return active.click() }
  var forgetButton = $('forget')
  if (active === forgetButton) {
    e.preventDefault()
    if (key === 'up') { var first = $('tiles').querySelector('.tile'); if (first) first.focus() }
    return
  }
  if (key === 'left' || key === 'right') { e.preventDefault(); step(key === 'left' ? -1 : 1) }
  if (key === 'down' && !forgetButton.hidden) { e.preventDefault(); return forgetButton.focus() }
  if (key === 'up' || key === 'down') e.preventDefault()
  if (!active || active === document.body) { e.preventDefault(); step(0) }
})

// ---------- Start ----------

var told = handedOff()
var last = saved()
if (told.to) openSaved(told.to, told.leave ? { leave: '1', back: told.me } : { status: told.status })
else if (last && !told.change) openSaved(last)
else showConnect()
