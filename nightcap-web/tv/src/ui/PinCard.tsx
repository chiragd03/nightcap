import { useEffect, useRef, useState } from 'react'
import { pinHost, type PinAsk } from '../admin'
import { focus } from '../focus'
import { useKeys } from '../nav'
import { avatar, avatarSrc, current } from '../profiles'
import Icon from './Icon'
import './PinCard.css'
import * as keyboard from '../keyboard'
import { useLimitsReady } from '../../../src/limits'

// The admin PIN card: over everything, the profile it's for, the PIN as dots (the
// TV's number keys or its keyboard), Unlock and Cancel side by side. Back is Cancel.

export default function PinHost() {
  const [ask, setAsk] = useState<PinAsk | null>(null)
  const [n, setN] = useState(0)
  useEffect(() => pinHost(a => { setAsk(a); setN(x => x + 1) }), [])
  return ask ? <PinCard key={n} ask={ask} /> : null
}

function PinCard({ ask }: { ask: PinAsk }) {
  const lim = useLimitsReady()
  const [pin, setPin] = useState('')
  const field = useRef<HTMLInputElement>(null)
  const go = useRef<HTMLButtonElement>(null)
  const opener = useRef(document.activeElement as HTMLElement | null)
  const me = current()
  const a = me && avatar(me)
  useEffect(() => { focus(field.current) }, [])

  const done = (value: string | null) => {
    focus(opener.current)
    value == null ? ask.onCancel() : ask.onPin(value)
  }
  useKeys((key, e) => {
    const inField = document.activeElement === field.current
    if (key === 'back') { done(null); return true }
    if (key === 'ok' && inField && keyboard.typing()) { e.preventDefault(); done(pin); return true }
    if (key === 'down' && inField) { focus(go.current); return true }
    if (key === 'up' && !inField) { focus(field.current); return true }
    if ((key === 'left' || key === 'right') && inField) return true
  })

  return (
    <div className="sheet-dim">
      <div className="pin-card" data-scope="" role="dialog" aria-label={ask.title}>
        <div className="pin-who">
          {a && <span className="pin-disc" style={{ background: a.tint }}><img src={avatarSrc(a.image)} alt="" /></span>}
          <span>{me ? `${me.name}  ·  Admin` : 'Admin'}</span>
        </div>
        <b className="pin-title">{ask.title}</b>
        <p className={`pin-detail${ask.problem ? ' problem' : ''}`}>{ask.problem ?? ask.detail}</p>
        <input ref={field} className="pin-field" data-f="" type="password" inputMode="numeric" pattern="[0-9]*" maxLength={lim.pin.max}
          placeholder="PIN" value={pin} aria-label="PIN" autoComplete="off"
          onChange={e => setPin(e.target.value.replace(/\D/g, '').slice(0, lim.pin.max))} />
        <div className="pin-choices">
          <button ref={go} className="sheet-item" data-f="" onClick={() => done(pin)}><Icon name="check" size={16} /> {ask.go}</button>
          <button className="sheet-item" data-f="" onClick={() => done(null)}><Icon name="act_close" size={16} /> Cancel</button>
        </div>
      </div>
    </div>
  )
}
