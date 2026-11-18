// Online subtitles: fetched through the server's link (playback.ts's subtitleText), read (SRT
// or WebVTT) into timed lines and drawn by the player, so their timing can be moved.

export type Cue = { start: number; end: number; text: string }

const time = (s: string) => {
  const m = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/.exec(s)
  if (!m) return NaN
  return ((+(m[1] ?? 0) * 60 + +m[2]) * 60 + +m[3]) * 1000 + +m[4].padEnd(3, '0')
}

export function parse(text: string): Cue[] {
  const out: Cue[] = []
  for (const block of text.replace(/\r/g, '').split(/\n{2,}/)) {
    const lines = block.split('\n')
    const at = lines.findIndex(l => l.includes('-->'))
    if (at < 0) continue
    const [a, b] = lines[at].split('-->')
    const start = time(a), end = time(b)
    if (isNaN(start) || isNaN(end)) continue
    const body = lines.slice(at + 1).join('\n').replace(/<[^>]+>/g, '').replace(/\{\\[^}]*\}/g, '').trim()
    if (body) out.push({ start, end, text: body })
  }
  // (In the file's order where two start together: Chromium 68's sort isn't stable.)
  return out.map((c, i) => ({ c, i })).sort((x, y) => x.c.start - y.c.start || x.i - y.i).map(x => x.c)
}

/** The line(s) showing at [ms] (with the timing moved by [delayMs]: later is positive). */
export function at(cues: Cue[], ms: number, delayMs: number) {
  const t = ms - delayMs
  const showing = cues.filter(c => c.start <= t && t < c.end)
  return showing.length ? showing.map(c => c.text).join('\n') : null
}

/** "The.Office.US.S05E13.720p.WEB-DL.en.srt" → "The Office US S05E13 720p WEB-DL". */
export const cleanRelease = (r: string) => r.replace(/\.(srt|vtt|ass|ssa|sub)$/i, '').replace(/\.[a-z]{2,3}$/i, '').replace(/[._]+/g, ' ').trim()
