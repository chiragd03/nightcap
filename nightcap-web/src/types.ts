// Shapes of the server's answers, as the TV app reads them.

export type Item = {
  id: string
  type: 'movie' | 'series' | 'tile'
  name?: string
  year?: string
  rating?: number
  poster?: string
  backdrop?: string
  trailer?: string
  overview?: string
  reason?: string
  label?: string
  rank?: number
  // Continue watching
  episode?: string
  progress?: number
  videoId?: string
  newEpisodes?: number
  nextVideoId?: string
  nextEpisode?: string
  muted?: boolean
}

export type Row = {
  id: string
  title: string
  style?: 'ranked' | 'tiles'
  items: Item[]
  /** The AI's answer the row came from (the server keeps it), sent back with what's opened from it. */
  requestId?: string
}

export type Weather = {
  city: string
  temp: number
  feels: number
  condition: string
  icon: string
  high: number
  low: number
  unit: string
}

export type AiUsage = { month: string; month_cost: number; month_calls: number }

export type Feed = {
  generated_at: number
  /** A refresh would change it (older than a few minutes, or new episodes not looked for yet). */
  stale?: boolean
  /** A profile's first Home, still being set up on the server: Continue watching only (the full one
   * comes by the refresh). */
  building?: boolean
  featured: Item[]
  rows: Row[]
  widgets: { weather?: Weather; ai?: AiUsage }
}

export type Profile = { id: string; name: string; avatar: string | null; isAdmin: boolean }

// Title, person and Browse pages.

export type Card = {
  id: string
  type?: 'movie' | 'series'
  name: string
  episode?: string
  overview?: string
  thumbnail?: string
  aired?: string
  rating?: number | string
  character?: string
  photo?: string
  poster?: string
  reason?: string
  year?: string
  backdrop?: string
  upcoming?: boolean
  watched?: boolean
  progress?: number
  rank?: number
}

export type Section = { id: string; title: string; kind: 'episodes' | 'cast' | 'posters'; items: Card[] }

export type Header = {
  id: string
  type: 'movie' | 'series' | 'person' | 'browse'
  name: string
  facts: string
  rating?: number | null
  overview: string
  backdrop?: string | null
  trailer?: string | null
  logo?: string | null
  notify?: boolean
  watched?: boolean
  myRating?: -1 | 1 | 2 | null
  /** Whether it's on this profile's My List. */
  inList?: boolean
}

export type Page = { header: Header; sections: Section[]; focus: { section: string; index: number } | null }

// The player: ranked sources and subtitles for one film or episode.

export type Stream = {
  /** Missing for a YouTube video (youtube). */
  url?: string
  /** A version the server converted for browsers (sound as AAC), once it offers one. */
  webUrl?: string
  addon: string
  filename: string
  resolution: string
  hdr: string[]
  video?: string | null
  audio?: string | null
  source?: string | null
  size: number
  /** Ready to play at once on its debrid service; null when it didn't say. */
  cached: boolean | null
  direct: boolean
  languages: string[]
  bingeGroup?: string | null
  label: string
  /** The file names another episode ("S2 E12"): never tried by itself, only picked by hand. */
  otherEpisode?: string
  /** Its file runs far from the title's length ("Runs 2 h 09 min, not 3 h 15 min"): another title, a
   *  sample or a stub. Never tried by itself either, only picked by hand. */
  otherLength?: string
  /** Known to be this film or episode (false: kept as a backup, it may be another one). */
  verified?: boolean
  /** From a last-resort add-on (a plugin): it adapts its quality. */
  plugin?: boolean
  /** An HLS stream (its address, a playback link, won't say). */
  hls?: boolean
  /** A YouTube video from an add-on: its id, played in YouTube's own player; no url then. */
  youtube?: string
  /** For a plugin's stream: whether a web page may play it (false: TVs only). */
  browser?: boolean
  lengthS?: number | null
  /** The add-on behind it in AIOStreams, and its debrid service's name. */
  via?: string | null
  service?: string | null
  serviceName?: string | null
  /** A file's id, the same across lookups: files are told apart by it, never by their link. */
  key?: string | null
  /** AIOStreams' stream type: "usenet", "debrid" (torrents), "http", or null. */
  kind?: string | null
  /** Its audio tracks from its own header, in track order (only the first few files are read). Trusted
   * over languages, which come from its name. */
  fileAudio?: string[] | null
  /** Seen gone lately (last within its group), or recorded dead (tried after everything else). */
  seen?: boolean | 1
  dead?: boolean | 1
}

export type Subtitle = { url: string; lang: string; language: string; release: string; addon: string }

export type Play = {
  id: string
  type: 'movie' | 'series'
  name: string
  episode?: string | null
  resume: number
  runtimeMs?: number
  streams: Stream[]
  subtitles: Subtitle[]
  why: string[]
  /** What the player says when no source would be tried by itself (the server's words), or null. */
  notice?: string | null
  /** The audio language the profile wants ("en"), and the title's original one. */
  audioLanguage?: string | null
  originalLanguage?: string | null
  next?: { id: string; episode: string; name: string; thumbnail?: string } | null
  myRating?: -1 | 1 | 2 | null
  asked: string[]
  finishedEpisodes?: number | null
  /** A film that isn't out yet: when it comes out ("2026-11-04", "" when not known). No streams then. */
  releases?: string
  /** Sources this play didn't ask or use (the plugins, the extra add-ons'): asked for with more=1. */
  moreSources?: boolean
  /** What this profile picked for this show before: an audio language ("hi"), subtitles ("eng", "off"). */
  titleAudio?: string | null
  titleSubtitles?: string | null
  /** When its playback links stop working (ms): renewed (play/renew) once they have. */
  linksExpireAt?: number
}

/** A file that seems not to be this one (another episode's, or far from its length): never tried by
 * itself, only picked by hand. */
export const suspect = (s: Pick<Stream, 'otherEpisode' | 'otherLength'>) => !!(s.otherEpisode || s.otherLength)
