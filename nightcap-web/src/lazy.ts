// Screens fetched when first opened (React.lazy), so the first page load carries only what Home needs.
// A click into one whose code isn't here yet keeps the screen it came from (navigations are
// transitions) and shows a thin bar along the top (TopBar) while the code comes.

import { lazy, useSyncExternalStore, type ComponentType } from 'react'

let loading = 0
const listeners = new Set<() => void>()
const changed = (by: number) => { loading += by; listeners.forEach(l => l()) }

/** Whether a screen's code is on its way. */
export const useScreenLoading = () =>
  useSyncExternalStore(l => { listeners.add(l); return () => { listeners.delete(l) } }, () => loading > 0)

/** A screen fetched when first shown; [pick] chooses it from its module. */
export function lazyScreen<M, P>(load: () => Promise<M>, pick: (m: M) => ComponentType<P>) {
  return lazy(() => {
    // (Counted after this render: the loader runs while React is drawing.)
    queueMicrotask(() => changed(1))
    const job = load()
    job.then(() => queueMicrotask(() => changed(-1)), () => queueMicrotask(() => changed(-1)))
    return job.then(m => ({ default: pick(m) }))
  })
}
