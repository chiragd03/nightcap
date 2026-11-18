// The admin PIN: asked before admin changes (adding or
// removing a profile). The session it unlocks is kept in memory only (api.adminSession), so closing
// the app or choosing another profile locks admin again. The card itself is ui/PinCard.

import { limits, whenLimits } from '../../src/limits'
import * as api from './api'
import { notify } from './ui/Notice'

export type PinAsk = { title: string; detail: string; go: string; problem?: string; onPin: (pin: string) => void; onCancel: () => void }
let showCard: (ask: PinAsk | null) => void = () => {}
export const pinHost = (show: (ask: PinAsk | null) => void) => { showCard = show }

// (The card checks the PIN's length by the server's limits: it waits for them, whichever way it's asked.)
const ask = async (a: Omit<PinAsk, 'onPin' | 'onCancel'>) => {
  await whenLimits()
  return new Promise<string | null>(resolve => {
    showCard({ ...a, onPin: pin => { showCard(null); resolve(pin) }, onCancel: () => { showCard(null); resolve(null) } })
  })
}

// (As long as the server allows: its limits.)
const valid = (pin: string) => /^\d+$/.test(pin) && pin.length >= limits().pin.min && pin.length <= limits().pin.max
const pinRule = () => `${limits().pin.min} to ${limits().pin.max} digits`
const UNREACHABLE = "Couldn't reach the server. Try again."
let checking = false

/** Whether admin is unlocked for an admin change, asking for the PIN (or setting one) if needed. */
export async function ensure(): Promise<boolean> {
  // (A second press while it's checking: one PIN card, not two.)
  if (checking) return false
  checking = true
  let state
  try { state = await api.request('/household/admin.json') } catch { notify(UNREACHABLE); return false } finally { checking = false }
  if (state.status === 403) { notify('Only the admin profile can do that'); return false }
  if (!state.ok) { notify("Couldn't check the admin PIN. Try again."); return false }
  if (state.body.unlocked === true) return true
  return state.body.pinSet === false ? setPin() : unlock()
}

async function unlock(problem?: string): Promise<boolean> {
  const pin = await ask({ title: 'Admin PIN', detail: 'Enter the admin PIN to make this change.', go: 'Unlock', problem })
  if (pin == null) return false
  if (!valid(pin)) return unlock(`A PIN is ${pinRule()}.`)
  let r
  try { r = await api.request('/household/admin/unlock', { body: { pin } }) } catch { notify(UNREACHABLE); return false }
  const error = typeof r.body.error === 'string' ? r.body.error : ''
  if (r.ok && typeof r.body.session === 'string') { api.setAdminSession(r.body.session); return true }
  if (r.status === 403 && /set the admin PIN/i.test(error)) return setPin()
  if (r.status === 429) {
    const minutes = Math.max(1, Math.ceil(Number(r.body.lockedFor ?? 60) / 60))
    notify(`Too many wrong PINs. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`)
    return false
  }
  if (r.status === 403 && typeof r.body.triesLeft === 'number') {
    const n = r.body.triesLeft
    return unlock(`That isn't the PIN. ${n} ${n === 1 ? 'try' : 'tries'} left.`)
  }
  notify("Couldn't unlock. Try again.")
  return false
}

async function setPin(problem?: string): Promise<boolean> {
  const first = await ask({ title: 'Set an admin PIN', detail: `Choose a PIN of ${pinRule()}. It's asked for before admin changes.`, go: 'Next', problem })
  if (first == null) return false
  if (!valid(first)) return setPin(`A PIN is ${pinRule()}.`)
  const again = await ask({ title: 'Set an admin PIN', detail: 'Type it again.', go: 'Set PIN' })
  if (again == null) return false
  if (again !== first) return setPin("Those didn't match. Choose a PIN again.")
  let r
  try { r = await api.request('/household/admin/pin', { body: { pin: first } }) } catch { notify(UNREACHABLE); return false }
  if (r.ok && typeof r.body.session === 'string') {
    api.setAdminSession(r.body.session)
    notify('Admin PIN set')
    return true
  }
  notify("Couldn't set the PIN. Try again.")
  return false
}
