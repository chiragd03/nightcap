// Audio languages as the player names and reads them: the names it says ("Hindi"), and a track's language
// as the server reads it. Plain functions, no browser: tested on their own (session.test.ts).

export const SPOKEN: Record<string, string> = {
  en: 'English', hi: 'Hindi', ta: 'Tamil', te: 'Telugu', ml: 'Malayalam', kn: 'Kannada', bn: 'Bengali', mr: 'Marathi',
  pa: 'Punjabi', gu: 'Gujarati', ur: 'Urdu', ko: 'Korean', ja: 'Japanese', zh: 'Chinese', es: 'Spanish', fr: 'French',
  de: 'German', it: 'Italian', pt: 'Portuguese', ru: 'Russian', tr: 'Turkish', ar: 'Arabic', th: 'Thai', id: 'Indonesian',
  pl: 'Polish', nl: 'Dutch', sv: 'Swedish', fa: 'Persian', vi: 'Vietnamese', uk: 'Ukrainian',
}
export const languageName = (code: string) => SPOKEN[code] ?? code

/** The language a track's name names ("Hindi DD+ 5.1" → "hi"), or null (none, or more than one): the
 * server's rule. */
export function namedLanguage(name: string | null | undefined): string | null {
  if (!name) return null
  const found = new Set(NAMED.filter(([, re]) => re.test(name)).map(([c]) => c))
  return found.size === 1 ? [...found][0] : null
}

/** The languages a track's name may name, as the server has them: its English
 * name, its own ("हिन्दी"), or its three-letter code as a word ("HIN"). */
const AUDIO_LANGUAGES: [string, string, string, string][] = [
  ['en', 'eng', 'English', 'English'], ['hi', 'hin', 'Hindi', 'हिन्दी'], ['es', 'spa', 'Spanish', 'Español'],
  ['fr', 'fre', 'French', 'Français'], ['de', 'ger', 'German', 'Deutsch'], ['it', 'ita', 'Italian', 'Italiano'],
  ['pt', 'por', 'Portuguese', 'Português'], ['ja', 'jpn', 'Japanese', '日本語'], ['ko', 'kor', 'Korean', '한국어'],
  ['zh', 'chi', 'Chinese', '中文'], ['ar', 'ara', 'Arabic', 'العربية'], ['ru', 'rus', 'Russian', 'Русский'],
  ['nl', 'dut', 'Dutch', 'Nederlands'], ['ta', 'tam', 'Tamil', 'தமிழ்'], ['te', 'tel', 'Telugu', 'తెలుగు'],
  ['pa', 'pan', 'Punjabi', 'ਪੰਜਾਬੀ'], ['ur', 'urd', 'Urdu', 'اردو'],
]
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const NAMED: [string, RegExp][] = AUDIO_LANGUAGES.map(([two, three, english, native]) =>
  [two, new RegExp(`(?<![a-z])${escape(english)}(?![a-z])|${escape(native)}|(?<![a-z])${three}(?![a-z])`, 'i')])

/** ISO 639-2 codes (bibliographic and terminology forms) to two letters, for the languages named above:
 * what a TV's player gives for a track ("eng", "fra", "deu", "zho"). */
const THREE: Record<string, string> = {
  eng: 'en', hin: 'hi', tam: 'ta', tel: 'te', mal: 'ml', kan: 'kn', ben: 'bn', mar: 'mr', pan: 'pa', guj: 'gu',
  urd: 'ur', kor: 'ko', jpn: 'ja', chi: 'zh', zho: 'zh', spa: 'es', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de',
  ita: 'it', por: 'pt', rus: 'ru', tur: 'tr', ara: 'ar', tha: 'th', ind: 'id', pol: 'pl', dut: 'nl', nld: 'nl',
  swe: 'sv', per: 'fa', fas: 'fa', vie: 'vi', ukr: 'uk',
}

/** A track's language tag as two letters ("eng", "en-US", "EN" → "en"), or null when it says none ("",
 * "und", "mul", "zxx", "mis"). An unknown tag is kept as it is, lower case. */
export function twoLetter(tag: string | null | undefined): string | null {
  const t = (tag ?? '').trim().toLowerCase().split(/[-_]/)[0]
  if (!t || t === 'und' || t === 'mul' || t === 'zxx' || t === 'mis') return null
  return t.length === 3 ? THREE[t] ?? t : t
}

/** Each audio track's language, as the server reads them: its header's reading when
 * it read this file (fileAudio, one per track), else the track's tag, or its name when the tag says nothing
 * or says English (Matroska's default: many releases leave the language out and name the track instead). */
export function trackLanguages(tracks: { language: string | null; name: string | null }[], fileAudio?: string[] | null): (string | null)[] {
  if (fileAudio && fileAudio.length === tracks.length) return fileAudio.map(l => (l === 'und' ? null : l))
  return tracks.map(t => (t.language == null || t.language === 'en' ? namedLanguage(t.name) ?? t.language : t.language))
}
