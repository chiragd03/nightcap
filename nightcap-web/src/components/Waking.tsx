import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { playerOpen } from '../appUpdate'
import { neverAnswered, onWaking } from '../waking'
import './Waking.css'

const MARK = `${import.meta.env.BASE_URL}brand/mark.png`

/** While the server starts after a quiet spell (see waking.ts): over everything when there's nothing
 * to show yet, else a small line at the top over what's shown (the last Home, kept in the browser). */
export default function Waking() {
  const [shown, setShown] = useState(false)
  // (Decided as it shows: whether the page has something of its own on it.)
  const [over, setOver] = useState(false)
  useEffect(() => onWaking(on => {
    // (Skeletons don't count: they're no page yet.)
    if (on) setOver(neverAnswered() && !document.querySelector('main .poster img, main .title-top h1, main .st-big, .who-person, .lv-grid > *'))
    setShown(on)
  }), [])
  useLocation() // (drawn again on every page: not over a player)
  // (Never over a player: it says what it's doing itself.)
  if (!shown || playerOpen()) return null
  if (!over) return <div className="waking-line glass" role="status" aria-live="polite">Waking up Nightcap…</div>
  return (
    <div className="waking" role="status" aria-live="polite">
      <img className="waking-mark" src={MARK} alt="" />
      <b>Waking up Nightcap…</b>
      <span>After a quiet spell the server takes a few seconds to start.</span>
    </div>
  )
}
