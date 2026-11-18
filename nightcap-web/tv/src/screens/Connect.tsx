import { useEffect, useRef, useState } from 'react'
import * as api from '../api'
import { focusFirst } from '../focus'
import { useKeys, useNav } from '../nav'
import { backTo, exit, forgetServer, here, launchCode, launcherUrl, leaveThere, otherServers, switchTo, toLauncher, where, type Saved } from '../platform'
import * as store from '../store'
import Aura from '../ui/Aura'
import Panel from '../ui/Panel'
import Sheet, { type Choice } from '../ui/Sheet'
import Tile from '../ui/Tile'
import Home from './Home'
import './Connect.css'

// Connecting to a household. The Android TV finds or is
// told a server here; on Samsung and LG the launcher already did that (it opened this app from the
// server), so "this server" is the one serving the app, and another server is the launcher's job.
// The rest is as on Android: the household's join code in eight boxes, or a pick of households on a
// home server, the household in use (IN USE) and the others this TV has joined (SWITCH TO, one press,
// no code: the launcher opens that server, with its own key), and the same words.

const SERVER_TINT = '#2E3F7A'
const OTHER_TINT = '#24506A'
const HOUSEHOLD_TINT = '#4A3A78'

/** Whether Connect is the screen in front (the TV forgotten elsewhere doesn't open it twice). */
export let connectInFront = false

type Step = { kind: 'servers' } | { kind: 'households'; server: string; list: { id: string; name: string }[] }
type PanelState = { kind: 'code'; initial: string }
type SheetState = { title: string; subtitle: string; choices: Choice[] }

/** Connecting…, Joining…, Leaving…: under way, so the line breathes; anything else (an
 * error, "This TV has left…") is still. */
const underWay = (text: string) => text.endsWith('…')

export default function Connect({ fresh, status: said = '', unreachable, leaveNow }: {
  fresh?: boolean
  /** What happened, from the launcher: another household left, say. */
  status?: string
  /** A server this TV has joined that couldn't be reached to leave it: forget it here, or keep it. */
  unreachable?: string
  /** Opened to leave this household, then go [back] to that server. */
  leaveNow?: { back?: string }
}) {
  const nav = useNav()
  const [step, setStep] = useState<Step>({ kind: 'servers' })
  const [panel, setPanel] = useState<PanelState | null>(null)
  const [status, setStatus] = useState(said)
  const [panelStatus, setPanelStatus] = useState('')
  const [serverName, setServerName] = useState('Nightcap')
  const [tint, setTint] = useState(SERVER_TINT)
  const [sheet, setSheet] = useState<SheetState | null>(null)
  const [, redraw] = useState(0)
  const busy = useRef(false)
  const row = useRef<HTMLDivElement>(null)
  const ready = store.ready()

  useEffect(() => {
    connectInFront = true
    return () => { connectInFront = false }
  }, [])

  // The server's name, for its tile.
  useEffect(() => { api.households().then(h => setServerName(h.server), () => {}) }, [])
  // Opened by the launcher for a server this TV isn't in yet: straight on to joining it (as the
  // Android TV does once an address is typed).
  useEffect(() => { if (fresh && !ready && !leaveNow) choose() }, [])
  // Left from another server: leave, then back there.
  useEffect(() => { if (leaveNow) leave(leaveNow.back) }, [])
  useEffect(() => {
    const s = unreachable && otherServers().find(x => x.url === unreachable)
    if (s) couldntReach(s.household || 'Your household', where(s.url), () => forgetServer(s.url))
  }, [])

  const say = (text: string) => (panel ? setPanelStatus(text) : setStatus(text))

  // Choosing the server: what joining takes.
  async function choose() {
    if (busy.current) return
    busy.current = true
    say('Connecting…')
    try {
      const h = await api.households()
      setServerName(h.server)
      if (h.codeRequired || h.households.length === 0) {
        setStatus('')
        setPanelStatus('')
        // (A code from the invite link the launcher was given, used once.)
        setPanel({ kind: 'code', initial: launchCode.take() ?? '' })
      } else if (h.households.length === 1) {
        await joinWith({ household: h.households[0].id })
      } else {
        setPanel(null)
        setStatus('')
        setStep({ kind: 'households', server: h.server, list: h.households })
        setTint(HOUSEHOLD_TINT)
        setTimeout(() => focusFirst(row.current), 0)
      }
    } catch (e) {
      say((e as Error).message)
    } finally {
      busy.current = false
    }
  }

  // Joining: then Home, with nothing to go back to.
  async function joinWith(how: { household: string } | { code: string }) {
    busy.current = true
    say('Joining…')
    try {
      await api.join(how)
      nav.reset(<Home />)
    } catch (e) {
      say((e as Error).message)
      busy.current = false
    }
  }

  const done = (text: string) => {
    setStatus(text)
    redraw(n => n + 1)
    setTimeout(() => focusFirst(row.current), 0)
  }

  // The household in use: keep using it, or leave it.
  const inUse = (name: string, at: string) => setSheet({ title: name, subtitle: `This TV uses it now: ${at}.`, choices: [
    { icon: 'nav_home', label: 'Keep using it', run: () => {} },
    { icon: 'sign_out', label: 'Leave this household', run: () => askLeave(name, at, () => leave()) },
  ] })

  const askLeave = (name: string, at: string, go: () => void) => setSheet({ title: `Leave ${name}?`,
    subtitle: `On ${at}. This TV stops using it, and can join again with a join code.`, choices: [
      { icon: 'sign_out', label: 'Leave', run: go },
      { icon: 'act_close', label: 'Stay', run: () => {} },
    ] })

  // [back]: the server this was asked from, to go back to once it's left.
  async function leave(back?: string) {
    if (busy.current) return
    busy.current = true
    const name = store.household.get() || 'Your household'
    const at = where(here)
    setStatus('Leaving…')
    try {
      if (store.ready()) await api.leave()
      if (back) return backTo(back, `This TV has left ${name} on ${at}.`)
      done(`This TV has left ${name} on ${at}.`)
    } catch {
      setStatus('')
      // (Its server off or out of reach: it can still be forgotten here.)
      couldntReach(name, at, api.forgetHere)
    } finally {
      busy.current = false
    }
  }

  /** Leaving [name] couldn't reach its server: forget it on this TV only ([forget]), or keep it. */
  const couldntReach = (name: string, at: string, forget: () => void) => setSheet({ title: `Couldn't reach ${name}`,
    subtitle: `On ${at}. Forget it on this TV only? It stays on that server's list of devices until it's removed there.`, choices: [
      { icon: 'sign_out', label: 'Forget it here', run: () => { forget(); done(`This TV has forgotten ${name} on ${at}.`) } },
      { icon: 'act_close', label: 'Keep it', run: () => {} },
    ] })

  // Another household this TV has joined: switch to it, or leave it.
  const joined = (s: Saved) => {
    const name = s.household || 'Your household'
    const at = where(s.url)
    setSheet({ title: name, subtitle: at, choices: [
      { icon: 'nav_home', label: 'Switch to it', run: () => { if (!busy.current) switchTo(s.url) } },
      { icon: 'sign_out', label: 'Leave this household', run: () => askLeave(name, at, () => {
        if (busy.current) return
        busy.current = true
        setStatus('Leaving…')
        leaveThere(s.url)
      }) },
    ] })
  }

  const backToServers = () => {
    setPanel(null)
    setPanelStatus('')
    setStatus('')
    setStep({ kind: 'servers' })
    setTint(SERVER_TINT)
    setTimeout(() => focusFirst(row.current), 0)
  }

  // Back: the code panel or the households → the servers; on the servers, Connect closes
  // (to Settings if it came from there, else the app closes).
  useKeys(key => {
    if (key !== 'back' || panel || sheet) return
    if (step.kind === 'households') { backToServers(); return true }
    // In no household (none yet, or just left the one in use): nothing behind this screen can be
    // used, so Back closes Nightcap, rather than a screen of the household left.
    if (!store.ready()) { exit(); return true }
    if (nav.depth > 1) return
    // (Opened by the launcher, back from another server: Home is behind it.)
    nav.reset(<Home />)
    return true
  })

  const household = store.household.get() || 'Your household'
  const title = step.kind === 'households' ? 'Which household?' : 'Connect to Nightcap'
  const hint = step.kind === 'households'
    ? `This TV joins one household on ${step.server}. Press Back for another server.`
    : 'Pick your Nightcap server. The one this TV opened is first.'

  return (
    <div className="connect">
      <Aura tint={tint} />
      <div className={`connect-body${panel ? ' behind' : ''}`} data-inert={panel ? '' : undefined}>
        <span className="eyebrow connect-eyebrow">Connect</span>
        <h1 className="connect-title">{title}</h1>
        <p className="connect-hint">{hint}</p>
        <div className="tile-row" onFocus={e => glide(e.currentTarget, e.target as HTMLElement)}>
          <div ref={row} className="tiles">
            {step.kind === 'servers' ? (
              <>
                {ready && (
                  <Tile label="In use" name={household} sub={where(here)} icon="nav_home"
                    onFocus={() => setTint(SERVER_TINT)} onClick={() => inUse(household, where(here))} />
                )}
                {otherServers().map(s => (
                  <Tile key={s.url} label="Switch to" name={s.household || 'Your household'} sub={where(s.url)} icon="nav_home"
                    onFocus={() => setTint(HOUSEHOLD_TINT)} onClick={() => joined(s)} />
                ))}
                <Tile label="This server" name={serverName} sub={ready ? 'Join another household here' : 'Join a household here'} icon="wifi" autoFocus
                  onFocus={() => setTint(SERVER_TINT)} onClick={choose} />
                {launcherUrl && (
                  <Tile label="Another server" name="Type an address" sub="At home or in the cloud" icon="globe"
                    onFocus={() => setTint(OTHER_TINT)} onClick={toLauncher} />
                )}
              </>
            ) : step.list.map((h, i) => (
              <Tile key={h.id} label="Household" name={h.name} sub="Join" icon="nav_home" autoFocus={i === 0}
                onFocus={() => setTint(HOUSEHOLD_TINT)} onClick={() => { if (!busy.current) joinWith({ household: h.id }) }} />
            ))}
          </div>
        </div>
        <p className={`connect-status${underWay(status) ? ' waiting' : ''}`} role="status">{status}</p>
      </div>

      {panel && (
        <Panel heading="Join code" code initial={panel.initial} go="Join" status={panelStatus} waiting={underWay(panelStatus)}
          text="Type your household's join code. Whoever looks after your household can give it to you."
          onGo={value => {
            if (busy.current) return
            const code = value.trim()
            if (!code) return setPanelStatus("Type the household's join code.")
            joinWith({ code })
          }}
          onCancel={backToServers} />
      )}

      {sheet && <Sheet key={sheet.title} title={sheet.title} subtitle={sheet.subtitle} choices={sheet.choices} onClose={() => setSheet(null)} />}
    </div>
  )
}

/** The row scrolls only when its tiles don't fit: just far enough to keep [tile] inside the page's
 * margin (the row's own padding at its ends), as the Android TV's. */
function glide(row: HTMLElement, tile: HTMLElement) {
  const margin = 72 * (parseFloat(getComputedStyle(document.documentElement).fontSize) || 1)
  const box = row.getBoundingClientRect()
  const r = tile.getBoundingClientRect()
  const delta = r.left < box.left + margin ? r.left - box.left - margin : r.right > box.right - margin ? r.right - box.right + margin : 0
  const most = Math.max(0, row.scrollWidth - row.clientWidth)
  const target = Math.min(most, Math.max(0, row.scrollLeft + delta))
  if (target !== row.scrollLeft) row.scrollTo({ left: target, behavior: 'smooth' })
}
