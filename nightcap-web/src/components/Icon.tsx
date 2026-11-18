import { ICONS, type IconName } from '../icons'

export default function Icon({ name, size = 22 }: { name: IconName; size?: number }) {
  const icon: { viewBox: number; d: string; stroke?: number } = ICONS[name]
  // (A few are drawn as lines, [stroke] wide, rather than filled shapes.)
  const lines = icon.stroke ? { fill: 'none', stroke: 'currentColor', strokeWidth: icon.stroke, strokeLinecap: 'round', strokeLinejoin: 'round' } as const : { fill: 'currentColor' }
  return (
    <svg width={size} height={size} viewBox={`0 0 ${icon.viewBox} ${icon.viewBox}`} {...lines} aria-hidden>
      <path d={icon.d} />
    </svg>
  )
}
