// What the TV keeps (localStorage on the server's own address), as the Android app's
// preferences. Separate from the web app's
// keys, which share this address in a desktop browser.

type Listener = () => void
const listeners = new Set<Listener>()
export function onStoreChange(l: Listener) { listeners.add(l); return () => { listeners.delete(l) } }
const changed = () => listeners.forEach(l => l())

function item(key: string) {
  return {
    get: () => { try { return localStorage.getItem(key) } catch { return null } },
    set: (v: string | null) => {
      try { v == null ? localStorage.removeItem(key) : localStorage.setItem(key, v) } catch { /* storage full or blocked */ }
      changed()
    },
  }
}

export const deviceKey = item('nightcap.tv.device')
export const household = item('nightcap.tv.household')
export const householdId = item('nightcap.tv.householdId')
export const currentProfile = item('nightcap.tv.profile')
export const profileList = item('nightcap.tv.profiles')
export const askNext = item('nightcap.tv.ask')

/** In a household: there's a device key (the server is the one serving this app). */
export const ready = () => !!deviceKey.get()

/** Profiles kept on this TV are someone else's after joining another household. */
export function forgetProfiles() {
  currentProfile.set(null)
  profileList.set(null)
  askNext.set('1')
}
