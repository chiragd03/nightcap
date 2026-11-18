import { useEffect, useState, type Ref } from 'react'
import * as feed from '../feed'
import Icon from '../ui/Icon'
import { sound } from './trailer'

// The clock, the trailer sound button, the weather and the AI's spend. The widgets load
// as Home comes to the front and every 10 minutes while it's there.

const EVERY_MS = 10 * 60_000

export function Clock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>
    const tick = () => { setNow(new Date()); t = setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50) }
    t = setTimeout(tick, 60_000 - (Date.now() % 60_000) + 50)
    return () => clearTimeout(t)
  }, [])
  const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  const date = now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }).replace(',', '')
  return (
    <div className="clock" aria-hidden>
      <span className="clock-time">{time}</span>
      <span className="clock-date">{date}</span>
    </div>
  )
}

function money(n: number) {
  if (n > 0 && n < 0.01) return `$${n.toFixed(3)}`
  return `$${n.toFixed(2)}`
}

/** Calls to a model without a price have no cost: the total is then at least this, or unknown (as on the
 * Android TV). */
function aiCost(cost: number, unpriced: number) {
  if (!unpriced) return money(cost)
  return cost === 0 ? 'cost unknown' : `${money(cost)}+`
}

function month(ym?: string) {
  const m = /^(\d{4})-(\d{2})$/.exec(ym ?? '')
  if (!m) return 'this month'
  return `in ${new Date(+m[1], +m[2] - 1, 1).toLocaleDateString(undefined, { month: 'short' })}`
}

/** The trailer sound button: top right, left of the weather. Home moves focus to it (Up
 * from the top row) and away (Down, Back); OK switches the sound for the whole TV. */
function SoundButton({ buttonRef }: { buttonRef?: Ref<HTMLButtonElement> }) {
  const [muted, setMuted] = useState(sound.muted)
  useEffect(() => sound.watch(setMuted), [])
  return (
    <button ref={buttonRef} className="sound-button" data-f="" data-sound="" aria-label="Trailer sound" onClick={() => sound.toggle()}>
      <Icon name={muted ? 'sound_off' : 'sound_on'} size={18} />
    </button>
  )
}

export function Widgets({ active, backdrop, soundRef }: { active: boolean; backdrop: string | null; soundRef?: Ref<HTMLButtonElement> }) {
  const [w, setW] = useState<feed.Widgets | null>(null)
  useEffect(() => {
    if (!active) return
    let t: ReturnType<typeof setTimeout>
    const load = () => {
      feed.widgets().then(got => { if (got) setW(got) })
      t = setTimeout(load, EVERY_MS)
    }
    load()
    return () => clearTimeout(t)
  }, [active])

  const weather = w?.weather
  const ai = w?.ai
  return (
    <>
      <div className="corner">
      <SoundButton buttonRef={soundRef} />
      {weather && (
        <div className="weather">
          {/* The frosted glass: the backdrop behind, blurred and lined up with it. */}
          <span className="weather-glass">{backdrop && <img src={backdrop} alt="" />}</span>
          <span className="weather-icon">{weather.icon}</span>
          <span className="weather-text">
            <span className="weather-temp">{Math.round(weather.temp ?? 0)}°<small>feels {Math.round(weather.feels ?? weather.temp ?? 0)}°</small></span>
            <span className="weather-sub">{[weather.city, weather.condition, `${Math.round(weather.high ?? 0)}° / ${Math.round(weather.low ?? 0)}°`].filter(Boolean).join(' · ')}</span>
          </span>
        </div>
      )}
      </div>
      {ai && <span className="ai-chip">✦ AI  {aiCost(ai.month_cost ?? 0, ai.month_unpriced_calls ?? 0)} {month(ai.month)}</span>}
    </>
  )
}
