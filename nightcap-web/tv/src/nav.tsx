// The app's screens, as the Android app's activity stack:
// opening a screen puts it on top; Back takes it off. The screens underneath stay mounted
// (hidden), so going back shows one exactly as it was left: its focus, scroll and anything typed.
// Every key goes through here: a screen or a panel on it may take it first (useKeys), then the
// arrows move focus (focus.ts), OK presses, and Back closes the screen on top.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ensureFocus, focus, focusFirst, move } from './focus'
import * as keyboard from './keyboard'
import { keyOf, type Key } from './keys'
import { showPending } from './ui/Notice'

type Entry = { id: number; node: ReactNode; state: 'in' | 'back-in' | 'shown' | 'leaving' | 'closing'; plain?: boolean }

type Nav = {
  /** Opens a screen on top. [plain]: a crossfade instead of the grow-in (Who's watching → Home). */
  push(node: ReactNode, plain?: boolean): void
  /** Closes the screen on top (Back, when nothing on it took the key). */
  pop(): void
  /** The screen on top swapped for another (the next episode's player): Back from it goes to the
   * screen underneath. */
  replace(node: ReactNode): void
  /** Everything closed, then this screen alone (after joining, or the TV forgotten). */
  reset(node: ReactNode): void
  /** Back to the first screen (Home), closing everything over it (the side panel's Home from
   * another screen). Home then closes its side panel and goes to its first row. */
  popToRoot(page?: HomePage): void
  /** How many screens are open. */
  depth: number
  /** The screen in front. */
  topId: number | undefined
}

const NavContext = createContext<Nav | null>(null)

/** Set when the side panel brought Home back (popToRoot): which page it asked for (Home, or its Shows
 * "tv" or Movies "movie"); Home takes it once. */
export type HomePage = 'home' | 'tv' | 'movie'
let homeAsked: HomePage | false = false
export const takeHomeAsked = () => { const was = homeAsked; homeAsked = false; return was }
const ScreenContext = createContext<number>(0)

export const useNav = () => useContext(NavContext)!

/** Whether this screen is the one in front (another screen opened over it isn't). */
export function useIsFront() {
  const screen = useContext(ScreenContext)
  return useNav().topId === screen
}

/** Runs [fn] each time this screen comes to the front: when it opens, when the screens over it
 * close, and when the app is shown again after another app (as an Android activity's onResume). */
export function useOnFront(fn: () => void) {
  const screen = useContext(ScreenContext)
  const { topId } = useNav()
  const ref = useRef(fn)
  ref.current = fn
  useEffect(() => { if (topId === screen) ref.current() }, [topId, screen])
  useEffect(() => {
    if (topId !== screen) return
    const shown = () => { if (document.visibilityState === 'visible') ref.current() }
    document.addEventListener('visibilitychange', shown)
    return () => document.removeEventListener('visibilitychange', shown)
  }, [topId, screen])
}

/** The screens that are players: a note left for later isn't shown over them. */
const players = new Set<number>()

/** Marks this screen as a player (the film, link and channel players). */
export function usePlayerScreen() {
  const screen = useContext(ScreenContext)
  useEffect(() => {
    players.add(screen)
    return () => { players.delete(screen) }
  }, [screen])
}

/** Handles keys while this screen is on top, before the app does; return true to take the key. The
 * latest handler registered goes first, so a panel opened on a screen sees keys before the screen.
 * Outside any screen (the admin PIN card, the Play on TV question) it applies over every screen. */
type Handler = (key: Key, e: KeyboardEvent) => boolean | void
const handlers: { screen: number; fn: { current: Handler } }[] = []

export function useKeys(fn: Handler, active = true) {
  const screen = useContext(ScreenContext)
  const ref = useRef(fn)
  ref.current = fn
  useEffect(() => {
    if (!active) return
    const h = { screen, fn: ref }
    handlers.push(h)
    return () => { handlers.splice(handlers.indexOf(h), 1) }
  }, [screen, active])
}

// (Screen transitions: in 320 ms, back 300 ms; out 320 ms, closing 260 ms.)
/** Keys a held press acts on once (as the Android TV's, and Back). */
const ONCE_KEYS: Key[] = ['back', 'ok', 'playpause', 'play', 'pause']
const LEAVE_MS = 320
const CLOSE_MS = 260

let nextId = 1

export function NavProvider({ first, atRoot, children }: { first: ReactNode; atRoot: () => void; children?: ReactNode }) {
  const [stack, setStack] = useState<Entry[]>(() => [{ id: nextId++, node: first, state: 'shown' }])
  // Where focus was on each screen when another opened over it.
  const focusOf = useRef(new Map<number, HTMLElement | null>())
  const top = stack.filter(e => e.state !== 'closing').slice(-1)[0]

  const push = useCallback((node: ReactNode, plain?: boolean) => {
    setStack(s => {
      const live = s.filter(e => e.state !== 'closing')
      const under = live[live.length - 1]
      if (under) focusOf.current.set(under.id, document.activeElement as HTMLElement | null)
      return [...live.map(e => (e === under ? { ...e, state: 'leaving' as const } : e)), { id: nextId++, node, state: 'in', plain }]
    })
  }, [])

  const pop = useCallback(() => {
    setStack(s => {
      const live = s.filter(e => e.state !== 'closing')
      if (live.length < 2) return s
      const closing = live[live.length - 1]
      return live.map(e => (e === closing ? { ...e, state: 'closing' as const } : e === live[live.length - 2] ? { ...e, state: 'back-in' as const } : e))
    })
  }, [])

  const replace = useCallback((node: ReactNode) => {
    setStack(s => {
      const live = s.filter(e => e.state !== 'closing')
      const top = live[live.length - 1]
      if (!top) return s
      return [...live.slice(0, -1), { ...top, state: 'closing' as const }, { id: nextId++, node, state: 'in' as const }]
    })
  }, [])

  const popToRoot = useCallback((page: HomePage = 'home') => {
    homeAsked = page
    setStack(s => {
      const live = s.filter(e => e.state !== 'closing')
      if (live.length < 2) return s
      // (Home goes to its first row itself: not back to where focus was.)
      focusOf.current.delete(live[0].id)
      const first: Entry = { ...live[0], state: 'back-in' }
      const last: Entry = { ...live[live.length - 1], state: 'closing' }
      return [first, last]
    })
  }, [])

  const reset = useCallback((node: ReactNode) => {
    focusOf.current.clear()
    setStack([{ id: nextId++, node, state: 'in', plain: true }])
  }, [])

  // Screens that have finished going away: hidden (left) or gone (closed).
  useEffect(() => {
    if (!stack.some(e => e.state === 'leaving' || e.state === 'closing')) return
    const t = setTimeout(() => setStack(s => s.filter(e => e.state !== 'closing').map(e => (e.state === 'leaving' ? { ...e, state: 'shown' } : e))),
      Math.max(LEAVE_MS, CLOSE_MS))
    return () => clearTimeout(t)
  }, [stack])

  // Focus on the screen in front: back where it was, or its first thing.
  const topId = top?.id
  useEffect(() => {
    if (topId == null) return
    const t = setTimeout(() => {
      const was = focusOf.current.get(topId)
      focusOf.current.delete(topId)
      if (!(was && was.isConnected && focus(was))) ensureFocus()
      // A note left for later ("Couldn't play this link"): on whichever screen comes up next (not over a
      // player).
      if (!players.has(topId)) showPending()
    }, 0)
    return () => clearTimeout(t)
  }, [topId])

  const depth = stack.filter(e => e.state !== 'closing').length
  const nav = useMemo(() => ({ push, pop, replace, reset, popToRoot, depth, topId }), [push, pop, replace, reset, popToRoot, depth, topId])

  // The one key listener.
  const latest = useRef({ topId, depth, pop, atRoot })
  latest.current = { topId, depth, pop, atRoot }

  // The app shown again after another app: the screen in front comes up again, so a note left for
  // later shows there too (not over a player).
  useEffect(() => {
    const shown = () => {
      const id = latest.current.topId
      if (document.visibilityState === 'visible' && id != null && !players.has(id)) showPending()
    }
    document.addEventListener('visibilitychange', shown)
    return () => document.removeEventListener('visibilitychange', shown)
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const key = keyOf(e)
      if (!key) return
      // A held key acts once: Back closes one screen, not several; a held OK opens a card's menu
      // and must not then press the menu's first choice as the key repeats; a held play key doesn't
      // flicker between pause and play.
      if (ONCE_KEYS.indexOf(key) >= 0 && e.repeat) { e.preventDefault(); return }
      const { topId, depth, pop, atRoot } = latest.current
      for (let i = handlers.length - 1; i >= 0; i--) {
        const h = handlers[i]
        if ((h.screen === topId || h.screen === 0) && h.fn.current(key, e)) { e.preventDefault(); return }
      }
      if (e.defaultPrevented) return
      const active = document.activeElement
      const typing = active instanceof HTMLInputElement
      switch (key) {
        case 'up': case 'down':
          e.preventDefault(); move(key); return
        case 'left': case 'right':
          // (In a text field the arrows move the cursor, until it's at the end.)
          if (typing && !atEdge(active as HTMLInputElement, key)) return
          e.preventDefault(); move(key); return
        case 'ok':
          // OK presses what has focus, on the key going down (a remote may send nothing after it;
          // the browser's own Enter-press is held back, so it can't press twice).
          // (In a text field: the keyboard's Enter types; with the keyboard closed, OK opens it.)
          if (typing) { if (!keyboard.open()) { e.preventDefault(); keyboard.reopen(active as HTMLInputElement) } return }
          e.preventDefault()
          if (active instanceof HTMLElement && active.hasAttribute('data-f')) active.click()
          else focusFirst()
          return
        case 'back':
          e.preventDefault()
          if (depth > 1) pop()
          else atRoot()
          return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <NavContext.Provider value={nav}>
      {stack.map(e => (
        <ScreenContext.Provider key={e.id} value={e.id}>
          <div className={`screen ${e.state}${e.plain ? ' plain' : ''}`} data-scope={e.id === topId ? '' : undefined}
            hidden={e.state === 'shown' && e.id !== topId} data-inert={e.id !== topId ? '' : undefined}>
            {e.node}
          </div>
        </ScreenContext.Provider>
      ))}
      {children}
    </NavContext.Provider>
  )
}

const atEdge = (input: HTMLInputElement, key: 'left' | 'right') => {
  try {
    const at = input.selectionStart ?? 0
    return key === 'left' ? at === 0 && input.selectionEnd === 0 : at === input.value.length
  } catch { return true }
}
