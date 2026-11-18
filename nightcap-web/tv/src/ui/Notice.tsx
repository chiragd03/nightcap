import { useEffect, useState } from 'react'
import './Notice.css'

// The app's short notes: glass, top right, in for 200 ms, held
// 2.4 s, out over 400 ms. A new one replaces the one showing. A "later" note waits for the next
// screen that comes to the front, not a player (one slot, in memory).

let show: (text: string) => void = () => {}
let pending: string | null = null

export const notify = (text: string) => show(text)
/** For a screen that's closing (the player after an error): shown on the next screen in front. */
export const later = (text: string) => { pending = text }
/** Called as a screen comes to the front (nav.tsx: any but a player). */
export function showPending() {
  if (pending) { const t = pending; pending = null; show(t) }
}

export default function Notices() {
  const [note, setNote] = useState<{ text: string; n: number } | null>(null)
  useEffect(() => { show = text => setNote(n => ({ text, n: (n?.n ?? 0) + 1 })) }, [])
  useEffect(() => {
    if (!note) return
    const t = setTimeout(() => setNote(null), 200 + 2400 + 400)
    return () => clearTimeout(t)
  }, [note])
  return note ? <div key={note.n} className="notice" role="status">{note.text}</div> : null
}
