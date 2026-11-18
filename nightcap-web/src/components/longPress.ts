import { useRef, type MouseEvent, type TouchEvent } from 'react'

/** How long a finger rests on a card before its menu opens. */
const HOLD_MS = 480
/** How far it may move meanwhile (a scroll, not a press). */
const SLOP_PX = 10

/**
 * A long press on a touch screen, for a card's menu: the ⋯ button's work without the button. (Android
 * also fires contextmenu on a long press; iOS doesn't, and shows its link preview instead, which the
 * card's CSS turns off.) The click that ends the press is swallowed, so the card doesn't open as well.
 */
export function useLongPress(onLong: (() => void) | undefined) {
  const timer = useRef(0)
  const start = useRef<{ x: number; y: number } | null>(null)
  const fired = useRef(false)
  const cancel = () => { clearTimeout(timer.current); start.current = null }
  return {
    onTouchStart: (e: TouchEvent) => {
      if (!onLong || e.touches.length !== 1) return
      fired.current = false
      start.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }
      clearTimeout(timer.current)
      timer.current = window.setTimeout(() => {
        fired.current = true
        start.current = null
        navigator.vibrate?.(10)
        onLong()
      }, HOLD_MS)
    },
    onTouchMove: (e: TouchEvent) => {
      const s = start.current
      if (s && Math.hypot(e.touches[0].clientX - s.x, e.touches[0].clientY - s.y) > SLOP_PX) cancel()
    },
    // (The finger lifting after the menu opened would click whatever is under it now, a menu item even:
    // not a click.)
    onTouchEnd: (e: TouchEvent) => { if (fired.current && e.cancelable) e.preventDefault(); cancel() },
    onTouchCancel: cancel,
    // (A long press after which no click came, on a touch laptop say: the mouse's next click is its own.)
    onMouseDown: () => { if (!start.current) fired.current = false },
    onClickCapture: (e: MouseEvent) => {
      if (!fired.current) return
      fired.current = false
      e.preventDefault()
      e.stopPropagation()
    },
  }
}
