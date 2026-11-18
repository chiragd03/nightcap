import './polyfills'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Watchers } from './App'
import { NavProvider } from './nav'
import { arrival, exit, registerKeys } from './platform'
import * as keyboard from './keyboard'
import * as store from './store'
import Connect from './screens/Connect'
import Home from './screens/Home'
import Notices from './ui/Notice'
import PinHost from './ui/PinCard'
import Ask from './ui/Ask'
import './tv.css'
import { loadLimits } from '../../src/limits'

// Start-up: in a household → Home; not yet → Connect, straight on to joining this server.
// Opened by the launcher to leave this household (asked on another server), or back from that with
// how it went: Connect.
registerKeys()
const arrived = arrival()
keyboard.watch()
// What the server allows (profiles, name lengths, the PIN…), asked once; the screens show again when it's in.
loadLimits()
// 1rem = 1 dp of the Android TV's 960 x 540 dp screen, as large as fits (CSS min() is too new for
// 2020 TVs, so it's set here).
const fit = () => { document.documentElement.style.fontSize = `${Math.min(innerWidth / 960, innerHeight / 540)}px` }
fit()
window.addEventListener('resize', fit)
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <NavProvider first={arrived.leave ? <Connect leaveNow={{ back: arrived.back }} />
      : arrived.status || arrived.unreachable ? <Connect status={arrived.status} unreachable={arrived.unreachable} />
      : store.ready() ? <Home /> : <Connect fresh />} atRoot={exit}>
      <Watchers />
      <PinHost />
      <Ask />
    </NavProvider>
    <Notices />
  </StrictMode>,
)
