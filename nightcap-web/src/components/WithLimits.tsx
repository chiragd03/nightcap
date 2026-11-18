import type { ReactNode } from 'react'
import { useLimits, useLimitsFailing } from '../limits'
import Waiting from './Waiting'

/** A screen that needs the server's limits (forms: names, the PIN, how many): shown once they're in;
 * meanwhile, that it's on its way, or that the server can't be reached yet (it's asked again). */
export default function WithLimits({ children }: { children: ReactNode }) {
  const lim = useLimits()
  const failing = useLimitsFailing()
  if (lim) return <>{children}</>
  return failing
    ? <Waiting key="failing" words="Nightcap can't connect right now. Trying again…" slowAfter={Infinity} />
    : <Waiting key="loading" after={300} />
}
