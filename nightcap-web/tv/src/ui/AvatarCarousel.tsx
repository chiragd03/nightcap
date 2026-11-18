import { useEffect, useRef, useState } from 'react'
import { useKeys } from '../nav'
import { AVATARS, avatarSrc } from '../profiles'
import './AvatarCarousel.css'

// The avatar picker: the avatars on a gentle curve, the chosen one big in the middle, the
// others smaller and fainter towards the edges. One focus stop: Left and Right move by one (no
// wrap), gliding 320 ms, or 140 ms while the key is held; OK picks.

const GLIDE_MS = 320
const HELD_MS = 140
const EASE = (t: number) => {
  // cubic-bezier(0.2, 0, 0, 1), close enough: a fast start easing into place.
  return 1 - Math.pow(1 - t, 3.2)
}

export default function AvatarCarousel({ value, onChange, onPick }: {
  value: number; onChange: (index: number) => void; onPick?: () => void
}) {
  const [pos, setPos] = useState(value)
  const [focused, setFocused] = useState(false)
  const self = useRef<HTMLDivElement>(null)
  const anim = useRef<{ from: number; to: number; start: number; ms: number; frame: number } | null>(null)

  const glideTo = (to: number, ms: number) => {
    const from = anim.current ? currentPos() : pos
    if (anim.current) cancelAnimationFrame(anim.current.frame)
    const a = { from, to, start: performance.now(), ms, frame: 0 }
    anim.current = a
    const step = (t: number) => {
      const k = Math.min(1, (t - a.start) / a.ms)
      setPos(a.from + (a.to - a.from) * EASE(k))
      if (k < 1) a.frame = requestAnimationFrame(step)
      else anim.current = null
    }
    a.frame = requestAnimationFrame(step)
  }
  const at = useRef(pos)
  at.current = pos
  const currentPos = () => at.current

  // (Picked from outside: straight there.)
  useEffect(() => { if (!anim.current) setPos(value) }, [value])
  useEffect(() => () => { if (anim.current) cancelAnimationFrame(anim.current.frame) }, [])

  useKeys((key, e) => {
    if (document.activeElement !== self.current) return
    if (key === 'left' || key === 'right') {
      const next = Math.max(0, Math.min(AVATARS.length - 1, value + (key === 'left' ? -1 : 1)))
      if (next !== value) { onChange(next); glideTo(next, e.repeat ? HELD_MS : GLIDE_MS) }
      return true
    }
    if (key === 'ok') { onPick?.(); return true }
  })

  return (
    <div ref={self} className={`carousel${focused ? ' focused' : ''}`} data-f="" tabIndex={0} role="listbox"
      aria-label="Avatar" onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}>
      {AVATARS.map((a, i) => {
        const d = i - pos, far = Math.abs(d)
        if (far > 5.5) return null
        const scale = Math.max(0.38, 1 - 0.19 * far)
        const x = d * 150 * (1 - 0.07 * Math.min(far, 5))
        const y = Math.pow(far, 1.5) * 5
        return (
          <span key={a.key} className="carousel-disc" aria-selected={i === value}
            style={{ background: a.tint, opacity: Math.max(0, 1 - 0.2 * far), zIndex: 100 - Math.round(far * 10),
              transform: `translate(${x}rem, ${y}rem) scale(${scale})` }}>
            <img src={avatarSrc(a.image)} alt="" />
          </span>
        )
      })}
      <span className="carousel-ring" aria-hidden />
    </div>
  )
}
