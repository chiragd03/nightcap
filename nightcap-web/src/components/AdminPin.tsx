import { useEffect, useRef, useState, type FormEvent } from 'react'
import * as api from '../api'
import Icon from './Icon'
import './AdminPin.css'
import { useLimitsReady } from '../limits'

// The admin PIN: asked before the Household pages (sources and keys, devices, profiles, the
// household's settings). The first time, the admin sets one (twice, to be sure); after that it
// unlocks admin on this device for a while. Digits only (as many as the server allows), shown as dots.

type Props = { pinSet: boolean; name: string; onUnlocked: () => void }

export default function AdminPin({ pinSet, name, onUnlocked }: Props) {
  const lim = useLimitsReady()
  const [pin, setPin] = useState('')
  const [first, setFirst] = useState<string>()   // setting one: the PIN typed the first time
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const field = useRef<HTMLInputElement>(null)
  useEffect(() => { field.current?.focus() }, [first])

  const setting = !pinSet
  const ok = /^\d+$/.test(pin) && pin.length >= lim.pin.min && pin.length <= lim.pin.max

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!ok || busy) return
    setError(undefined)
    if (setting && first === undefined) { setFirst(pin); setPin(''); return }
    if (setting && pin !== first) { setError("The two PINs don't match. Start again."); setFirst(undefined); setPin(''); return }
    setBusy(true)
    try {
      if (setting) await api.adminSetPin(pin)
      else await api.adminUnlock(pin)
      onUnlocked()
    } catch (err) {
      setPin('')
      if (err instanceof api.WrongPin) setError(err.triesLeft === 1 ? 'Wrong PIN. One more try before it locks.' : `Wrong PIN. ${err.triesLeft} tries left.`)
      else if (err instanceof api.PinLocked) setError(`Too many wrong PINs. Try again in ${Math.ceil(err.seconds / 60)} minutes.`)
      // (Plain words, as the TVs say them: never the server's own text.)
      else if (err instanceof TypeError) setError("Couldn't reach the server. Try again.")
      else setError(setting ? "Couldn't set the PIN. Try again." : "Couldn't unlock. Try again.")
    } finally {
      setBusy(false)
    }
  }

  const title = setting ? (first === undefined ? 'Set an admin PIN' : 'Type it again') : 'Admin PIN'
  const line = setting
    ? first === undefined
      ? `The household's sources, keys, devices and profiles will need it. Only ${name} should know it.`
      : 'The same PIN, to be sure.'
    : `To change the household's sources, keys, devices and profiles. It stays unlocked on this device for 30 minutes.`

  return (
    <form className="pin glass" onSubmit={submit}>
      <span className="pin-lock" aria-hidden><Icon name="act_watched" size={26} /></span>
      <h3>{title}</h3>
      <p>{line}</p>
      <label className="pin-field">
        <input ref={field} id="admin-pin" type="password" inputMode="numeric" autoComplete={setting ? 'new-password' : 'current-password'}
          pattern="\d*" maxLength={lim.pin.max} value={pin} onChange={e => setPin(e.target.value.replace(/\D/g, ''))}
          aria-label={title} aria-describedby="admin-pin-note" />
        <span className="pin-dots" aria-hidden>
          {Array.from({ length: Math.max(4, pin.length) }, (_, i) => <i key={i} className={i < pin.length ? 'on' : ''} />)}
        </span>
      </label>
      <p id="admin-pin-note" className={`pin-note${error ? ' bad' : ''}`}>{error ?? `${lim.pin.min} to ${lim.pin.max} digits`}</p>
      <button className="btn primary" disabled={!ok || busy}>{busy ? 'Checking…' : setting ? (first === undefined ? 'Next' : 'Set the PIN') : 'Unlock'}</button>
      {!setting && <p className="pin-forgot">Forgotten it? The server's owner can reset it.</p>}
    </form>
  )
}
