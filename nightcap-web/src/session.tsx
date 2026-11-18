import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { device, onIdentityChange, profile, profiles } from './api'
import { keep, PROFILES, readKept } from './kept'
import type { Profile } from './types'

// Who's using the app: whether this browser has joined a household, and the profile watching.
// Screens read it with useSession(); App decides from it whether to join or ask who's watching.

type Session = {
  joined: boolean
  profileId: string | null
  me?: Profile
  /** The household's profiles: the last ones known (kept in this browser) until the server answers. */
  all: Profile[]
  /** Whether the profiles are in from the server, on their way, or couldn't be had. */
  profiles: 'loading' | 'ready' | 'failed'
  reload: () => void
}

const SessionContext = createContext<Session>({ joined: false, profileId: null, all: [], profiles: 'loading', reload: () => {} })

export function SessionProvider({ children }: { children: ReactNode }) {
  const read = () => ({ key: device.get(), profileId: profile.get() })
  const [ids, setIds] = useState(read)
  // (The device key the profiles are for: another household's key, its own profiles.)
  const keyFor = useRef(ids.key)
  const [all, setAll] = useState<Profile[]>(() => readKept<Profile[]>(PROFILES) ?? [])
  const [status, setStatus] = useState<Session['profiles']>('loading')
  const [tick, setTick] = useState(0)

  useEffect(() => onIdentityChange(() => {
    const now = read()
    setIds(now)
    // Another household (joined, or this browser's key gone): its profiles aren't the last ones.
    if (now.key !== keyFor.current) {
      keyFor.current = now.key
      setAll([]); setStatus('loading')
    }
  }), [])

  const joined = ids.key != null
  useEffect(() => {
    if (!joined) return
    let gone = false
    profiles().then(r => {
      if (gone) return
      setAll(r.profiles); setStatus('ready'); keep(PROFILES, r.profiles)
    }, () => { if (!gone) setStatus('failed') })
    return () => { gone = true }
  }, [ids.key, ids.profileId, tick])

  const me = all.find(p => p.id === ids.profileId)
  const reload = useCallback(() => { setStatus('loading'); setTick(t => t + 1) }, [])
  return (
    <SessionContext.Provider value={{ joined, profileId: ids.profileId, me, all, profiles: status, reload }}>
      {children}
    </SessionContext.Provider>
  )
}

export const useSession = () => useContext(SessionContext)
