// The big pictures, sized to the screen (pictures falling back when they can't load: components/Img).

const TMDB_WIDE = /^(https:\/\/image\.tmdb\.org\/t\/p\/)(w1280|original)(\/.+)$/

/** A wide TMDB picture (a backdrop) at the size the screen needs: a phone takes w780, not w1280. */
export function wide(url: string) {
  const m = url.match(TMDB_WIDE)
  if (!m) return { src: url }
  return { src: url, srcSet: `${m[1]}w780${m[3]} 780w, ${m[1]}w1280${m[3]} 1280w`, sizes: '100vw' }
}
