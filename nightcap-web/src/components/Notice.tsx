import { useCallback, useState } from 'react'
import './Menu.css'

/** A short glass message in the corner ("Season 2 marked as watched"): [node, show]. */
export function useNotice() {
  const [msg, setMsg] = useState<{ text: string; n: number }>()
  const show = useCallback((text: string) => setMsg(m => ({ text, n: (m?.n ?? 0) + 1 })), [])
  const node = msg ? <div key={msg.n} className="notice glass" role="status" onAnimationEnd={() => setMsg(undefined)}>{msg.text}</div> : null
  return [node, show] as const
}
