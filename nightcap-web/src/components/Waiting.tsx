import { useEffect, useState } from 'react'
import './Waiting.css'

/** Something on its way: a quiet line, shown after [after] ms (so a quick answer shows nothing),
 * then "Still working on it…" when it takes longer than [slowAfter] ms. */
export default function Waiting({ words = 'Loading…', after = 0, slowAfter = 4000 }: { words?: string; after?: number; slowAfter?: number }) {
  const [shown, setShown] = useState(after <= 0)
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    const a = after > 0 ? setTimeout(() => setShown(true), after) : undefined
    const b = Number.isFinite(slowAfter) ? setTimeout(() => setSlow(true), slowAfter) : undefined
    return () => { clearTimeout(a); clearTimeout(b) }
  }, [after, slowAfter])
  if (!shown) return <div className="waiting" aria-hidden />
  return (
    <div className="waiting" role="status">
      <span className="waiting-dot" aria-hidden />
      <p>{slow ? 'Still working on it…' : words}</p>
    </div>
  )
}
