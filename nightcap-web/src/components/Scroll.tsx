import { useEffect, useLayoutEffect, useRef } from 'react'
import { useLocation, useNavigationType } from 'react-router-dom'
import { takeScroll } from '../appUpdate'

// Where each page was scrolled to, by its place in this tab's history (each Back/Forward entry
// its own). The browser's own restoring is off: it restores before the page's rows are in.
const scrolled = new Map<string, number>()
// (How long Back keeps trying to reach where it was, while the page's rows come in.)
const RESTORE_FOR_MS = 3000

/** One place for scrolling between pages: a new page opens at the top, Back (or Forward) goes to
 * where that page was, and a page replacing itself (Search's address following the typing, the next
 * episode) leaves the scroll as it is. */
export default function Scroll() {
  const { key, pathname } = useLocation()
  const how = useNavigationType()

  useEffect(() => {
    try { history.scrollRestoration = 'manual' } catch { /* old browsers */ }
  }, [])

  useEffect(() => {
    let frame = 0
    const keep = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => scrolled.set(key, window.scrollY)) }
    window.addEventListener('scroll', keep, { passive: true })
    return () => { cancelAnimationFrame(frame); window.removeEventListener('scroll', keep) }
  }, [key])

  // (The page opening: where it was before a reload for a new version, if it was reloaded for one.)
  const opening = useRef(true)
  useLayoutEffect(() => {
    const first = opening.current
    opening.current = false
    if (!first && how === 'PUSH') { window.scrollTo(0, 0); return }
    const y = first ? takeScroll() : how === 'POP' ? scrolled.get(key) : undefined
    if (!y) return
    // (Until the page is long enough to get there, or the pointer, a key or a finger moves it.)
    const until = performance.now() + RESTORE_FOR_MS
    let frame = 0
    const stop = () => { cancelAnimationFrame(frame); ['wheel', 'touchstart', 'keydown'].forEach(t => removeEventListener(t, stop)) }
    const go = () => {
      window.scrollTo(0, y)
      if (Math.abs(window.scrollY - y) > 2 && performance.now() < until) frame = requestAnimationFrame(go)
      else stop()
    }
    ;['wheel', 'touchstart', 'keydown'].forEach(t => addEventListener(t, stop, { passive: true }))
    go()
    return stop
  }, [key, pathname, how])

  return null
}
