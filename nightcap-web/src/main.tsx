import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { watchVersions } from './appUpdate'
import { loadLimits } from './limits'
import { watchServer } from './waking'

watchServer()
// What the server allows (profiles, name lengths, the PIN…), asked once; the screens show again when it's in.
loadLimits()
// The app kept in the browser (a service worker), so it opens at once even while the server is
// asleep, and a new version after a deploy is offered (appUpdate.ts).
watchVersions()
// (A screen whose code a deploy took away: components/Boundary reloads into the new version, when
// it's the screen being opened. Not here: a background fetch that failed reloads nothing.)
// The player's code, ready before it's asked for: fetched while nothing else is happening, once the
// kept copy of the app is in place (on a first visit, it's being kept already).
addEventListener('load', () => {
  if (!navigator.serviceWorker?.controller) return
  const later = window.requestIdleCallback ?? ((f: () => void) => setTimeout(f, 2000))
  later(() => { import('./screens/Player').catch(() => {}) })
}, { once: true })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
