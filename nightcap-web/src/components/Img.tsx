import { useState, type ReactNode } from 'react'

type Props = {
  src?: string; srcSet?: string; sizes?: string; alt?: string; className?: string
  /** Shown instead when there's no picture, or it can't load. */
  fallback?: ReactNode
  /** Fetched only when near the screen (a row's posters); not for a page's main picture. */
  lazy?: boolean
  /** A page's main picture (the largest thing on it): fetched first, and shown as soon as it's in,
   * not faded. */
  main?: boolean
}

/** A picture that fades in once it's in (not one already there when the page drew), and shows
 * [fallback] instead if it can't load. */
export default function Img({ src, srcSet, sizes, alt = '', className, fallback = null, lazy = true, main = false }: Props) {
  const [broken, setBroken] = useState<string>()
  if (!src || src === broken) return <>{fallback}</>
  if (main) return <img src={src} srcSet={srcSet} sizes={sizes} alt={alt} className={className} fetchPriority="high" onError={() => setBroken(src)} />
  return (
    <img src={src} srcSet={srcSet} sizes={sizes} alt={alt} loading={lazy ? 'lazy' : undefined} decoding="async"
      className={className ? `${className} fade-in` : 'fade-in'}
      ref={el => { if (el?.complete) el.classList.add('in') }}
      onLoad={e => e.currentTarget.classList.add('in')} onError={() => setBroken(src)} />
  )
}
