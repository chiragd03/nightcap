// The languages the player remembers: per profile, on this TV for the instant start, and
// on the server (the truth, kept in step each time Home loads).

import * as api from '../api'
import * as profiles from '../profiles'

/** The Android TV's table: 3-letter codes and names. */
export const LANGS: [string, string][] = [
  ['eng', 'English'], ['hin', 'Hindi'], ['spa', 'Spanish'], ['fre', 'French'], ['ger', 'German'], ['ita', 'Italian'],
  ['por', 'Portuguese'], ['jpn', 'Japanese'], ['kor', 'Korean'], ['chi', 'Chinese'], ['ara', 'Arabic'], ['rus', 'Russian'],
  ['dut', 'Dutch'], ['tam', 'Tamil'], ['tel', 'Telugu'], ['pan', 'Punjabi'], ['urd', 'Urdu'],
]
export const nameOf = (code: string) => LANGS.find(l => l[0] === code)?.[1]

type Prefs = { audioLanguage?: string; subtitleLanguage?: string }
const key = () => `nightcap.tv.player.${profiles.currentId() ?? 'none'}`
function read(): Prefs { try { return JSON.parse(localStorage.getItem(key()) ?? '{}') as Prefs } catch { return {} } }
function write(p: Prefs) { try { localStorage.setItem(key(), JSON.stringify(p)) } catch { /* storage full */ } }

/** The audio language's name ("English" unless chosen). */
export const audio = () => read().audioLanguage ?? 'English'
/** The subtitles' 3-letter code, or "off" ("eng" unless chosen). */
export const subtitles = () => read().subtitleLanguage ?? 'eng'

export function saveAudio(name: string) {
  write({ ...read(), audioLanguage: name })
  api.post('/launcher/profile', { settings: { audio_language: name } }).catch(() => {})
}
export function saveSubtitles(code: string) {
  write({ ...read(), subtitleLanguage: code })
  api.post('/launcher/profile', { settings: { subtitles: code } }).catch(() => {})
}

/** The server's choices over this TV's; one the server lacks is sent up. */
export async function sync() {
  try {
    const got = await api.call<{ settings?: { audio_language?: string; subtitles?: string } }>('/launcher/profile.json')
    const s = got.settings ?? {}, mine = read(), next = { ...mine }, send: Record<string, string> = {}
    if (s.audio_language) next.audioLanguage = s.audio_language
    else if (mine.audioLanguage) send.audio_language = mine.audioLanguage
    if (s.subtitles) next.subtitleLanguage = s.subtitles
    else if (mine.subtitleLanguage) send.subtitles = mine.subtitleLanguage
    write(next)
    if (Object.keys(send).length) api.post('/launcher/profile', { settings: send }).catch(() => {})
  } catch { /* next time */ }
}
