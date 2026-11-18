import { useEffect, useRef } from 'react'

// The soft glow behind Connect and Who's watching: three colour pools that move to the
// focused tile's tint over 600 ms. The tint is brightened first (saturation ×1.35 up to 0.85,
// brightness 0.78), as on the Android TV.

type RGB = [number, number, number]

const hex = (h: string): RGB => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)) as RGB

function brighten([r, g, b]: RGB): RGB {
  const max = Math.max(r, g, b) / 255, min = Math.min(r, g, b) / 255
  const d = max - min
  let h = 0
  if (d) {
    const R = r / 255, G = g / 255, B = b / 255
    h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  const s = Math.min(0.85, (max ? d / max : 0) * 1.35), v = 0.78
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c
  const [a, bb, cc] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]
  return [(a + m) * 255, (bb + m) * 255, (cc + m) * 255]
}

const rgba = ([r, g, b]: RGB, a: number) => `rgba(${r | 0},${g | 0},${b | 0},${a})`

export default function Aura({ tint }: { tint: string }) {
  const el = useRef<HTMLDivElement>(null)
  const now = useRef<RGB>(brighten(hex('#2E3A4A')))
  useEffect(() => {
    const from = now.current, to = brighten(hex(tint)), start = performance.now()
    let frame = 0
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / 600)
      const e = 1 - Math.pow(1 - k, 3)
      const c = from.map((v, i) => v + (to[i] - v) * e) as RGB
      now.current = c
      if (el.current) {
        el.current.style.background = [
          `radial-gradient(circle at 50% 52%, ${rgba(c, 0.4)} 0, transparent 460rem)`,
          `radial-gradient(circle at 10% 105%, ${rgba(c, 0.29)} 0, transparent 403rem)`,
          `radial-gradient(circle at 95% -5%, ${rgba(c, 0.25)} 0, transparent 365rem)`,
        ].join(', ')
      }
      if (k < 1) frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
  }, [tint])
  return <div ref={el} className="aura" aria-hidden />
}
