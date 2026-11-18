// The web app's side of the player session (session.ts's Host): its server calls, and what this browser
// can play (as it is, or the smart way through Mediabunny).

import * as api from '../api'
import { fit, smartFit, smartSupported } from '../compat'
import { askLink } from './link'
import { NOT_IN_BROWSER, type Host } from './session'
import { notOutYet } from './words'

export const webHost: Host = {
  play: (type, videoId, o) => api.play(type, videoId, o),
  askLink,
  renewLinks: (token, runtimeMs) => api.renewLinks(token, runtimeMs),
  audioLanguages: links => api.audioLanguages(links),
  sourceFailed: (id, addon, why, filename) => { void api.sourceFailed(id, addon, why, filename) },
  sourcePlayed: (id, key) => { void api.sourcePlayed(id, key) },
  sourceGone: (id, addon, key) => { void api.sourceGone(id, addon, key) },
  canPlay: s => {
    if (s.youtube) return true
    // (A plugin's stream a web page may not read: no CORS headers.)
    if (s.plugin && s.browser === false) return false
    return fit(s) !== 'no' || (smartSupported() && smartFit(s))
  },
  tracksSwitchable: () => smartSupported(),
  nothingPlaysHere: NOT_IN_BROWSER,
  notOutYet,
  // (The smart way reads the file's own tracks, in the header's order.)
  headerIndexes: true,
  profileKey: () => api.profile.get() ?? '',
}
