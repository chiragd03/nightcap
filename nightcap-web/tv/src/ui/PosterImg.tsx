import { useState } from 'react'

/** A title's poster; one that doesn't load (an address with no picture behind it) shows the title's
 * name instead, as a card with no poster would want, not an empty card. */
export default function PosterImg({ src, name }: { src?: string | null; name?: string }) {
  const [broken, setBroken] = useState<string>()
  if (src && src !== broken) return <img src={src} alt="" onError={() => setBroken(src)} />
  return name ? <span className="poster-name">{name}</span> : null
}
