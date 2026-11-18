import { useEffect } from 'react'
import * as api from './api'
import { useNav } from './nav'
import * as profiles from './profiles'
import * as store from './store'
import Connect, { connectInFront } from './screens/Connect'
import { askWhoIsWatching } from './screens/Profiles'
import { isPlaying } from './playing'

/** Away this long counts as the TV having slept. The Android TV is told when the
 * screen goes off; a web app is only told it's hidden, which is also another app or input being
 * picked, so a short time away doesn't ask who's watching. */
const SLEPT_MS = 5 * 60_000

/** App-wide watchers:
 * - A TV the server forgets goes to Connect with nothing to go back to, checked on every
 *   answer and each time the app comes back to the front (not only at start, as on Android).
 * - While hidden the app is blank, so waking never flashes a stale screen. Back after
 *   sleeping, with more than one profile: Who's watching first. */
export function Watchers() {
  const nav = useNav()
  useEffect(() => {
    const toConnect = () => { if (!connectInFront) nav.reset(<Connect />) }
    // Removed by the household: said, not left to guess.
    api.whenForgotten(household => {
      if (!connectInFront) nav.reset(<Connect status={`This TV was removed from ${household}. Join again with a join code.`} />)
    })
    let hiddenAt = 0
    let midFilm = false
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now()
        // (Fell asleep mid-film: carry on as the same person.)
        midFilm = isPlaying()
        document.body.classList.add('asleep')
        return
      }
      document.body.classList.remove('asleep')
      if (!store.ready()) return toConnect()
      if (hiddenAt && !midFilm && Date.now() - hiddenAt >= SLEPT_MS) profiles.askNextTime()
      hiddenAt = 0
      if (!connectInFront && profiles.shouldAsk()) askWhoIsWatching(nav.push, true)
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [nav])
  return null
}
