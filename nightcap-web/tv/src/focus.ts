// Moving focus with the remote's arrows: from what has focus to the nearest focusable thing in that
// direction, inside the front-most scope (a panel or menu that's open, else the screen in front).
// Focusable things carry data-f; a scope is data-scope (the screen's own element is one). Anything
// that moves focus its own way (a row that remembers its card) handles the key first and calls
// preventDefault, and this leaves it alone.

export type Dir = 'up' | 'down' | 'left' | 'right'

const visible = (el: Element) => {
  const r = el.getBoundingClientRect()
  return r.width > 0 && r.height > 0 && !(el as HTMLElement).closest('[hidden], [data-inert]')
}

/** The front-most open scope: the last visible one in the page (panels are drawn after what's under them). */
export function scope(): HTMLElement | null {
  const all = Array.from(document.querySelectorAll<HTMLElement>('[data-scope]')).filter(visible)
  return all[all.length - 1] ?? null
}

/** The focusable things in [within]: a scope (a screen or a panel), or any part of one (a row of
 * chips, the editor's carousel). Never those of a scope opened inside it. */
export function focusables(within: Element | null = scope()): HTMLElement[] {
  if (!within) return []
  const own = within.hasAttribute('data-scope') ? within : within.closest('[data-scope]')
  return Array.from(within.querySelectorAll<HTMLElement>('[data-f]')).filter(el => {
    if ((el as HTMLButtonElement).disabled || !visible(el)) return false
    return el.closest('[data-scope]') === own
  })
}

export function focus(el: HTMLElement | null | undefined) {
  if (!el) return false
  el.focus({ preventScroll: true })
  return document.activeElement === el
}

/** Focus the first thing (or the one marked data-autofocus) in the front-most scope. */
export function focusFirst(within: Element | null = scope()) {
  const list = focusables(within)
  return focus(list.find(el => el.hasAttribute('data-autofocus')) ?? list[0])
}

/** Whether focus is somewhere in the front-most scope; if not, it's put on its first thing. */
export function ensureFocus() {
  const s = scope()
  const a = document.activeElement
  if (s && a instanceof HTMLElement && s.contains(a) && a.closest('[data-scope]') === s && visible(a)) return
  focusFirst(s)
}

export function move(dir: Dir): boolean {
  const s = scope()
  const from = document.activeElement as HTMLElement | null
  if (!s || !from || !s.contains(from)) {
    // Nothing focused here (the TV's keyboard closed by Back takes focus off its field): the
    // first thing, but not a text field unless going up, so the keyboard doesn't open again.
    const list = focusables(s)
    const field = (el: HTMLElement) => el instanceof HTMLInputElement
    return focus((dir === 'up' ? undefined : list.find(el => !field(el))) ?? list[0])
  }
  const a = from.getBoundingClientRect()
  let best: HTMLElement | null = null, bestScore = Infinity
  for (const el of focusables(s)) {
    if (el === from) continue
    const b = el.getBoundingClientRect()
    // How far along the way (must be ahead) and how far off to the side.
    let ahead: number, side: number, overlap: number
    if (dir === 'left' || dir === 'right') {
      ahead = dir === 'right' ? b.left - a.right : a.left - b.right
      overlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
      side = overlap > 0 ? 0 : Math.abs((b.top + b.bottom) / 2 - (a.top + a.bottom) / 2)
    } else {
      ahead = dir === 'down' ? b.top - a.bottom : a.top - b.bottom
      overlap = Math.min(a.right, b.right) - Math.max(a.left, b.left)
      side = overlap > 0 ? 0 : Math.abs((b.left + b.right) / 2 - (a.left + a.right) / 2)
    }
    if (ahead < -2) continue
    const score = Math.max(0, ahead) + side * 3
    if (score < bestScore) { bestScore = score; best = el }
  }
  return best ? focus(best) : false
}
