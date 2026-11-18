import type { ReactNode } from 'react'
import { useLimits, useLimitsFailing } from '../../../src/limits'

/** A TV screen that needs the server's limits (names, the PIN, how many): shown once they're in;
 * meanwhile, that it's on its way, or that the server can't be reached yet (it's asked again). */
export default function WithLimits({ children }: { children: ReactNode }) {
  const lim = useLimits()
  const failing = useLimitsFailing()
  if (lim) return <>{children}</>
  return <div className="limits-wait" role="status">{failing ? "Can't reach the server yet. Trying again…" : 'Loading…'}</div>
}
