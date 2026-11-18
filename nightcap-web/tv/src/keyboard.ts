// The TV's on-screen keyboard and the app's text fields, one set of rules for all of them (the
// address and join code panels, Search's box, profile names, the PIN):
//
// - OK on a field whose keyboard is closed opens it again (reopen): the TV opens its keyboard
//   when a field gains focus, so the field is let go and focused again.
// - OK (or Done) while the keyboard is open is the field's action: join, search, keep the name.
// - Back while the keyboard is open only closes it (the TV keeps that key), and the field keeps
//   focus (webOS keeps it there; if a TV takes it away, it's put back here), so the arrows go on
//   from it and OK opens the keyboard again.
//
// A desktop browser has no on-screen keyboard: a focused field is always typing.

import { kind } from './platform'

let shown = false
let last: HTMLInputElement | null = null
let reopening = false

const isField = (el: Element | null): el is HTMLInputElement => el instanceof HTMLInputElement

/** Whether the TV's keyboard is up (always, for a focused field in a desktop browser). */
export function open(): boolean {
  return kind === 'browser' ? isField(document.activeElement) : shown
}

/** Whether OK in [el] is its action: it's a field and the keyboard is up. False for a field with
 * the keyboard closed: the caller leaves the key alone, so the TV opens the keyboard. */
export function typing(el: Element | null = document.activeElement): boolean {
  return isField(el) && open()
}

/** Opens the keyboard again for [el], a focused field: the TV opens it when a field gains focus.
 * (A moment between, so webOS has finished with the blur before the focus.) */
export function reopen(el: HTMLInputElement) {
  reopening = true
  el.blur()
  setTimeout(() => {
    reopening = false
    el.focus({ preventScroll: true })
    const end = el.value.length
    try { el.setSelectionRange(end, end) } catch { /* (a field type without a caret) */ }
  }, 150)
}

function hidden() {
  shown = false
  if (reopening) return
  // (After the keyboard's own focus change has happened.)
  setTimeout(() => {
    const a = document.activeElement
    if (last && last.isConnected && (!a || a === document.body)) last.focus({ preventScroll: true })
  }, 0)
}

export function watch() {
  document.addEventListener('focusin', e => {
    if (!isField(e.target as Element)) return
    last = e.target as HTMLInputElement
    // (Typing goes on at the end, wherever the caret was left.)
    const el = last, end = el.value.length
    setTimeout(() => { try { if (document.activeElement === el) el.setSelectionRange(end, end) } catch { /* no caret */ } }, 0)
  })
  // A field losing focus to nothing is the keyboard closing (not the app moving focus, which
  // always focuses something else).
  document.addEventListener('focusout', e => {
    if (isField(e.target as Element) && !(e as FocusEvent).relatedTarget && kind !== 'browser') hidden()
  })
  // webOS: { detail: { visibility } }. Tizen: softkeyboardchange { state: 'on' | 'off' }.
  window.addEventListener('keyboardStateChange', e => {
    const v = (e as CustomEvent<{ visibility?: boolean }>).detail?.visibility
    if (v) shown = true
    else hidden()
  })
  window.addEventListener('softkeyboardchange', e => {
    if ((e as Event & { state?: string }).state === 'on') shown = true
    else hidden()
  })
  // Typing into a field means its keyboard is up (a TV that sends neither event).
  document.addEventListener('input', e => { if (isField(e.target as Element)) shown = true })
  // The keyboard goes with the field's focus.
  document.addEventListener('focusin', e => { if (!isField(e.target as Element)) shown = false })
}
