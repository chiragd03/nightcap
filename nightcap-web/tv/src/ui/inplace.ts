import { useLayoutEffect, useRef, type RefObject } from 'react'

// A row's cards changing in place, as the Android TV's:
// unchanged cards stay put, moved ones slide to their new place (320 ms), new ones
// fade in and removed ones fade out (200 ms). Cards are the track's children marked data-key (their
// id); a removed card's old element is put back at its old place, out of the focus order, while it
// fades. Only after the row has been drawn once: a row's first cards just appear.

const EASE = 'cubic-bezier(0.2, 0, 0, 1)'
type Spot = { el: HTMLElement; left: number; top: number }

function spots(t: HTMLElement) {
  const out = new Map<string, Spot>()
  for (const c of Array.from(t.children) as HTMLElement[]) {
    const key = c.dataset.key
    if (key && !c.hasAttribute('data-ghost')) out.set(key, { el: c, left: c.offsetLeft, top: c.offsetTop })
  }
  return out
}

export function useInPlace(track: RefObject<HTMLElement | null>, items: unknown) {
  // Where the cards are just before new items are drawn (read while the page still shows the old
  // ones), so a row whose cards settled after it was first drawn doesn't slide for nothing.
  const last = useRef(items)
  const before = useRef<Map<string, Spot> | null>(null)
  if (last.current !== items) {
    last.current = items
    before.current = track.current ? spots(track.current) : null
  }
  useLayoutEffect(() => {
    const t = track.current
    const was = before.current
    before.current = null
    if (!t || !was || typeof t.animate !== 'function') return
    const now = spots(t)
    now.forEach((spot, key) => {
      const old = was.get(key)
      if (!old) spot.el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: EASE })
      else if (old.left !== spot.left) {
        spot.el.animate([{ transform: `translateX(${old.left - spot.left}px)` }, { transform: 'translateX(0)' }], { duration: 320, easing: EASE })
      }
    })
    was.forEach((old, key) => {
      if (now.has(key)) return
      const ghost = old.el
      ghost.setAttribute('data-ghost', '')
      ghost.removeAttribute('data-f')
      ghost.removeAttribute('data-i')
      ghost.tabIndex = -1
      ghost.style.position = 'absolute'
      ghost.style.left = `${old.left}px`
      ghost.style.top = `${old.top}px`
      ghost.style.pointerEvents = 'none'
      t.appendChild(ghost)
      const a = ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, easing: EASE, fill: 'forwards' })
      a.onfinish = () => ghost.remove()
    })
  }, [items])
}
