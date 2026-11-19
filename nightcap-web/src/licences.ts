// Licences and credits (Settings › Licences and credits, as the Android TV's): where the titles, the
// weather and the episodes come from, and each part the app is made with, with its licence in full.

import tmdbLogo from './assets/tmdb.svg'

export { tmdbLogo }

/** TMDB's API terms ask for its logo and this line, word for word. */
export const TMDB_NOTICE = 'This product uses the TMDB API but is not endorsed or certified by TMDB.'
export const DATA_CREDITS = 'Weather data by Open-Meteo.com  ·  Episode data from TVmaze'
/** Nightcap's own licence, and where its source is (the AGPL asks for the way to it to be shown). */
export const SOURCE_URL = 'https://github.com/chiragd03/nightcap'
export const SOURCE_NOTE = 'Nightcap is free software under the GNU AGPL-3.0. Source: github.com/chiragd03/nightcap'

/** A part: its name, its licence's short name, and its licence's text (loaded when it's shown). */
export type Part = { name: string; licence: string; text: () => Promise<string> }

const text = (load: () => Promise<{ default: string }>) => () => load().then(m => m.default)
const FONTS: Part[] = [
  { name: 'Hanken Grotesk', licence: 'OFL-1.1', text: text(() => import('./fonts/OFL-hanken-grotesk.txt?raw')) },
  { name: 'Big Shoulders', licence: 'OFL-1.1', text: text(() => import('./fonts/OFL-big-shoulders.txt?raw')) },
]
const ICONS: Part[] = [
  { name: 'Fluent Emoji', licence: 'MIT', text: text(() => import('./licenses/fluent-emoji.txt?raw')) },
  { name: 'Phosphor Icons', licence: 'MIT', text: text(() => import('./licenses/phosphor-icons.txt?raw')) },
]

/** The web app's parts. */
export const WEB_PARTS: Part[] = [
  {
    name: 'React, React Router', licence: 'MIT',
    text: () => Promise.all([import('./licenses/react.txt?raw'), import('./licenses/react-router.txt?raw')]).then(([a, b]) => `${a.default}\n\n----------\n\n${b.default}`),
  },
  { name: 'hls.js', licence: 'Apache-2.0', text: text(() => import('./licenses/hls-js.txt?raw')) },
  { name: 'Mediabunny', licence: 'MPL-2.0', text: text(() => import('./licenses/mediabunny.txt?raw')) },
  { name: 'FFmpeg (AC-3 and DTS sound)', licence: 'LGPL-2.1', text: text(() => import('./licenses/ffmpeg.txt?raw')) },
  ...FONTS,
  ...ICONS,
]

/** The Samsung and LG app's parts. */
export const TV_PARTS: Part[] = [
  { name: 'React', licence: 'MIT', text: text(() => import('./licenses/react.txt?raw')) },
  { name: 'hls.js', licence: 'Apache-2.0', text: text(() => import('./licenses/hls-js.txt?raw')) },
  { name: 'Material Icons', licence: 'Apache-2.0', text: text(() => import('./licenses/material-icons.txt?raw')) },
  ...FONTS,
  ...ICONS,
]
