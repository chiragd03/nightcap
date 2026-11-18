import { ICONS, type IconName } from '../icons'

/** One of the Android app's line icons, [size] in dp (rem). */
export default function Icon({ name, size = 22, className }: { name: IconName; size?: number; className?: string }) {
  const icon = ICONS[name]
  return (
    <svg className={className} style={{ width: `${size}rem`, height: `${size}rem` }} viewBox={`0 0 ${icon.w} ${icon.h}`} aria-hidden>
      {icon.paths.map((p, i) => {
        const q = p as { d: string; stroke?: number; nofill?: boolean }
        return q.stroke
          ? <path key={i} d={q.d} fill="none" stroke="currentColor" strokeWidth={q.stroke} strokeLinecap="round" strokeLinejoin="round" />
          : <path key={i} d={q.d} fill={q.nofill ? 'none' : 'currentColor'} />
      })}
    </svg>
  )
}
