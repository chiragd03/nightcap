import { useEffect, useRef, useState } from 'react'
import { handler, opened, type Opened } from '../../../src/livetvHandler'
import { focus as focusEl } from '../focus'
import { Clock } from '../home/Widgets'
import * as live from '../livetv'
import type { LiveCard } from '../livetv'
import { useKeys, useNav, usePlayerScreen } from '../nav'
import { holdAwake, isAsking, setPlaying } from '../playing'
import * as profiles from '../profiles'
import Icon from '../ui/Icon'
import { notify } from '../ui/Notice'
import { ChannelTile, glow, metaOf, MyChannelsSheet } from '../screens/LiveTv'
import { createEngine, type Engine } from './engine'
import '../screens/LiveTv.css'
import './Player.css'

// Watching a channel, as on the Android TV. While it plays,
// any key first only brings up its name (top left), the buttons in the middle (Pause, an event's
// Sources, My channels; Pause focused) and the row's channels at the bottom, so nothing changes
// unseen. Down goes from the buttons to the row (Left/Right along it, OK watches one, held: My
// channels), Up back. While it starts the middle shows a turning light; when there's nothing to watch
// (not on yet, off air) it says so there, with the row up and no buttons. The remote's own play/pause
// and channel keys work at once. Each channel's streams are tried best first; one that doesn't start
// within a while counts as failed, and when none plays the server is told (only while the TV is
// online, so a dropped connection never hides a channel).

const START_WITHIN_MS = 15_000
/** Playing this long since a reconnect: a later drop is tried again once more. */
const CALM_MS = 30_000
const INFO_FOR_MS = 4_000
const REPORT_EVERY_S = 60
const MIN_REPORT_S = 5
const LONG_PRESS_MS = 500
const PICKS = 'nightcap.tv.live.picks'

type Stage = { s: 'loading' | 'playing' | 'nothing'; eyebrow?: string; title?: string; sub?: string }

/** Each profile's last channel of each event, so an event opens on it again. */
const pickKey = (c: LiveCard) => `${profiles.currentId() ?? ''}:${c.id}`
function picks(): Record<string, string> { try { return JSON.parse(localStorage.getItem(PICKS) ?? '{}') } catch { return {} } }
function savePick(c: LiveCard, member: string) { try { localStorage.setItem(PICKS, JSON.stringify({ ...picks(), [pickKey(c)]: member })) } catch { /* storage off */ } }
/** The channel an event's card opens on: this profile's last pick, else its first. */
function memberOf(c: LiveCard) {
  if (!c.channels || c.channels.length < 2) return c.id
  const last = picks()[pickKey(c)]
  return c.channels.find(x => x.id === last)?.id ?? c.channels[0].id
}

export default function LivePlayer({ list, at, row }: { list: LiveCard[]; at: number; row: string }) {
  const nav = useNav()
  // (A note left for later waits for the screen after it.)
  usePlayerScreen()
  const box = useRef<HTMLDivElement>(null)
  const engine = useRef<Engine | null>(null)
  const ready = useRef<Promise<Engine> | null>(null)
  // (Closed for Play on TV: no stream opens in the moment before the screen goes.)
  const closed = useRef(false)
  const [channels, setChannels] = useState(list)
  const [index, setIndex] = useState(() => Math.min(Math.max(0, at), list.length - 1))
  const [picked, setPicked] = useState(index)
  const [member, setMember] = useState<string>(() => memberOf(list[index]))
  const [stage, setStage] = useState<Stage>({ s: 'loading', eyebrow: 'Tuning in' })
  const [state, setState] = useState('STARTING')
  const [infoOn, setInfoOn] = useState(true)
  const [shown, setShown] = useState(false)
  const [inRow, setInRow] = useState(false)
  const [paused, setPaused] = useState(false)
  const [panel, setPanel] = useState(false)
  const [menu, setMenu] = useState<LiveCard | null>(null)
  const [attempt, setAttempt] = useState(0)
  const ch = channels[index]
  const buttonsOn = stage.s === 'playing'
  const actions = useRef<HTMLDivElement>(null)
  const lastButton = useRef<HTMLElement | null>(null)
  const rowForced = useRef(false)
  const swallowed = useRef<number | null>(null)
  const seconds = useRef(0)
  const playingId = useRef(member)
  playingId.current = member
  const now = useRef({ stage, shown, inRow, paused, panel, picked, index, buttonsOn, channels })
  now.current = { stage, shown, inRow, paused, panel, picked, index, buttonsOn, channels }

  // The TV's player, once; it's told what plays now (Play on TV pauses it while it asks).
  const onPlaying = useRef<() => void>(() => {})
  const onError = useRef<() => void>(() => {})
  useEffect(() => {
    // (hls.js where the TV has it, Samsung too: a stream's handler may give it settings.)
    const p = createEngine(box.current!, {
      playing: () => { setPaused(false); onPlaying.current() },
      paused: () => setPaused(true),
      time() {}, length() {}, buffering() {}, tracks() {}, cue() {},
      ended: () => onError.current(),
      error: () => onError.current(),
    }, true)
    ready.current = p
    p.then(e => { engine.current = e })
    const letGo = holdAwake()
    const unregister = setPlaying({
      pause: () => { const e = engine.current; if (!e || e.isPaused()) return false; e.pause(); return true },
      resume: () => engine.current?.play(),
      // (Play on TV: what it played is told now, under the profile that watched it.)
      close: () => { closed.current = true; report(); engine.current?.stop(); nav.pop() },
    })
    // How long it played, told every minute (and when it changes or closes).
    const tick = setInterval(() => {
      const e = engine.current
      if (e && !e.isPaused() && now.current.stage.s === 'playing') { seconds.current++; if (seconds.current >= REPORT_EVERY_S) report() }
    }, 1000)
    return () => { clearInterval(tick); report(); letGo(); unregister(); p.then(e => e.destroy()) }
  }, [])
  const report = () => {
    const s = seconds.current
    seconds.current = 0
    if (s >= MIN_REPORT_S && playingId.current) live.watching(playingId.current, s)
  }

  // ---------- Playing ----------

  /** Watch [i] (round the row), an event at [pick] or its last pick. */
  const play = (i: number, pick?: string) => {
    report()
    const n = now.current.channels.length
    const to = ((i % n) + n) % n
    setIndex(to)
    setPicked(to)
    setMember(pick ?? memberOf(now.current.channels[to]))
    setAttempt(a => a + 1)
  }

  // The channel's streams, best first, until one plays.
  useEffect(() => {
    const c = channels[index]
    if (!c) return
    let gone = false, timer: ReturnType<typeof setTimeout> | undefined, attempted = false
    // The channel's stream played this time (so a failure after is a drop, tried again once). Its one
    // retry comes back only after a while playing well: a stream that keeps dropping moves on to the next.
    let played = false, reconnected = false, calm: ReturnType<typeof setTimeout> | undefined
    setPaused(false)
    engine.current?.stop()
    setInfoOn(true)
    // (Not on yet, until its start time: then it's tried.)
    if (c.state === 'upcoming' && (c.startsAt ?? Infinity) > Date.now()) {
      setState('SOON')
      setStage({ s: 'nothing', eyebrow: 'Starts', title: c.startsAt ? live.timeText(c.startsAt) : 'Later', sub: "It isn't on yet. Pick another from the row below." })
      return
    }
    setState('STARTING')
    setStage({ s: 'loading', eyebrow: 'Tuning in' })
    const tryFrom = async (streams: live.LivePlay['streams'], i: number): Promise<void> => {
      clearTimeout(timer)
      const e = await ready.current!
      if (gone || closed.current) return
      const s = streams[i]
      if (!s) {
        e.stop()
        setState('NOT PLAYING')
        setStage({ s: 'nothing', eyebrow: 'Off air', title: attempted ? 'Not playing right now' : "Can't play on this TV", sub: 'Pick another from the row below.' })
        // Only a real failure (a stream was tried and the TV is online) hides the channel. (Not one that
        // played here and then dropped: that's the source's outage, not a dead channel.)
        if (attempted && !played && navigator.onLine !== false) live.failed(member)
        return
      }
      let got: Opened | null = { url: s.url }
      if (s.recipe) {
        try { got = opened(await handler({ link: s.url, recipe: s.recipe, target: () => live.linkTarget(s.url) })) } catch { got = null }
        if (gone || closed.current) return
        // (One this TV can't open: on to the next, not counted as a failure.)
        if (!got) return tryFrom(streams, i + 1)
      }
      attempted = true
      const next = () => {
        if (gone || closed.current) return
        onPlaying.current = () => {}
        onError.current = () => {}
        if (now.current.stage.s === 'playing') setStage({ s: 'loading', eyebrow: 'Tuning in' })
        tryFrom(streams, i + 1)
      }
      const failedNow = () => {
        if (gone || closed.current) return
        clearTimeout(calm)
        // It was playing and dropped (a short outage at the source): the same stream again, once, before
        // the next (the start limit still guards it).
        if (played && !reconnected) {
          reconnected = true
          onPlaying.current = () => {}
          onError.current = () => {}
          setStage({ s: 'loading', eyebrow: 'Reconnecting' })
          tryFrom(streams, i)
          return
        }
        next()
      }
      onPlaying.current = () => {
        clearTimeout(timer)
        // (No subtitles on live channels, as on the Android TV: none the stream carries are shown.)
        e.selectText(null)
        if (gone || now.current.stage.s !== 'loading') return
        played = true
        clearTimeout(calm)
        calm = setTimeout(() => { reconnected = false }, CALM_MS)
        setState('LIVE')
        setStage({ s: 'playing' })
      }
      onError.current = failedNow
      timer = setTimeout(next, START_WITHIN_MS)
      e.open(got!.url, 0, s.hls, undefined, got!.hls)
    }
    live.play(member).then(p => { if (!gone) tryFrom(p.streams, 0) }, () => {
      if (gone) return
      setState('NOT PLAYING')
      setStage({ s: 'nothing', eyebrow: "Can't connect", title: 'Server not reachable', sub: 'Try again in a moment, or pick another from the row below.' })
    })
    return () => { gone = true; clearTimeout(timer); clearTimeout(calm); onPlaying.current = () => {}; onError.current = () => {} }
  }, [attempt])

  // ---------- What's on screen ----------

  // The name, buttons and row go after a while (not while paused, nothing plays, or a panel or menu is up).
  const [wake, setWake] = useState(0)
  const laterHide = () => setWake(w => w + 1)
  useEffect(() => {
    if (paused || stage.s === 'nothing' || panel || menu) return
    const t = setTimeout(hideControls, INFO_FOR_MS)
    return () => clearTimeout(t)
  }, [wake, paused, stage.s, panel, menu, shown])

  const firstButton = () => actions.current?.querySelector<HTMLElement>('[data-f]') ?? null
  /** The name and row up, and the buttons while something plays (Pause first); else the row has the keys. */
  function showControls() {
    setShown(true)
    setInfoOn(true)
    setPicked(now.current.index)
    if (!now.current.buttonsOn) { if (!now.current.inRow) { setInRow(true); rowForced.current = true } }
    else if (rowForced.current) { rowForced.current = false; setInRow(false); setTimeout(() => focusEl(firstButton()), 0) }
    else if (!now.current.inRow && !actions.current?.contains(document.activeElement)) setTimeout(() => focusEl(firstButton()), 0)
    laterHide()
  }
  /** Back to the picture: the buttons and row go; the name too, unless a stream is starting. */
  function hideControls() {
    if (now.current.stage.s === 'nothing') return
    setShown(false)
    setInRow(false)
    rowForced.current = false
    if (now.current.stage.s === 'playing') setInfoOn(false)
    ;(document.activeElement as HTMLElement | null)?.blur?.()
  }
  // A stage that comes: nothing to watch brings the row (with its keys); the buttons come and go with it.
  useEffect(() => {
    if (stage.s === 'nothing' || now.current.shown) showControls()
    else if (stage.s === 'playing') laterHide()
  }, [stage])

  const toRow = (on: boolean) => {
    if (!on && !now.current.buttonsOn) return
    setInRow(on)
    setPicked(now.current.index)
    if (on) {
      lastButton.current = actions.current?.contains(document.activeElement) ? document.activeElement as HTMLElement : null
      ;(document.activeElement as HTMLElement | null)?.blur?.()
    } else setTimeout(() => focusEl(lastButton.current?.isConnected ? lastButton.current : firstButton()), 0)
  }

  const togglePause = () => {
    const e = engine.current
    if (!e || !now.current.buttonsOn) return
    if (e.isPaused()) e.play(); else e.pause()
    showControls()
  }
  useEffect(() => { if (stage.s === 'playing') setState(paused ? 'PAUSED' : 'LIVE') }, [paused])

  const toggleFavourite = (i: number) => {
    const c = channels[i]
    if (!c) return
    const on = !c.favourite
    live.favourite(c.id, on).then(() => {
      setChannels(cs => cs.map((x, n) => (n === i ? { ...x, favourite: on } : x)))
      notify(on ? 'Added to My channels' : 'Taken out of My channels')
    }, () => notify("Couldn't save that. Try again."))
  }
  const backToSources = () => setTimeout(() => focusEl(actions.current?.querySelector<HTMLElement>('[data-act="sources"]') ?? firstButton()), 0)

  // ---------- Keys ----------

  // OK in the row: short watches the picked one, held (500 ms) opens its My channels menu.
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; long: boolean } | null>(null)
  useEffect(() => {
    const up = (e: KeyboardEvent) => {
      // (Play on TV asking over the channel: its question's keys, not this row's.)
      if (isAsking()) { press.current = null; return }
      // (A key whose press only brought the controls up: its release does nothing.)
      if (swallowed.current != null && e.keyCode === swallowed.current) { swallowed.current = null; return }
      if (e.keyCode !== 13 && e.key !== 'Enter') return
      const p = press.current
      if (!p) return
      press.current = null
      clearTimeout(p.timer)
      const { picked: k, index: i, stage: st } = now.current
      if (p.long) { if (st.s !== 'nothing') laterHide() }
      // (The same one, not playing: OK tries it again.)
      else if (k !== i || st.s === 'nothing') play(k)
    }
    window.addEventListener('keyup', up)
    return () => window.removeEventListener('keyup', up)
  }, [])

  useKeys((key, e) => {
    if (menu || isAsking()) return
    const s = now.current
    const first = !e.repeat
    // The remote's own keys say what they do: at once.
    if (key === 'playpause' || key === 'play' || key === 'pause') {
      if (first) {
        const p = engine.current
        if (p && (key === 'playpause' || p.isPaused() === (key === 'play'))) togglePause(); else showControls()
      }
      return true
    }
    if (key === 'chup' || key === 'chdown') {
      if (first) {
        // (An open channel panel was the last one's: it goes.)
        if (s.panel) { setPanel(false); backToSources(); laterHide() }
        play(s.index + (key === 'chup' ? 1 : -1))
      }
      return true
    }
    if (s.panel) {
      if (key === 'back') { setPanel(false); backToSources(); laterHide(); return true }
      return
    }
    if (!s.shown) {
      if (key === 'back') return
      // Hidden: a key only brings up the name, buttons and row, so nothing changes unseen.
      if (first) { swallowed.current = e.keyCode; showControls() }
      return true
    }
    if (s.stage.s !== 'nothing' && !s.paused) laterHide()
    if (s.inRow) {
      switch (key) {
        case 'up': if (first) toRow(false); return true
        case 'back':
          if (s.stage.s === 'nothing') return
          if (s.buttonsOn) toRow(false); else hideControls()
          return true
        case 'left': case 'right': {
          rowForced.current = false        // looking along it now: stay there when it starts
          const n = s.channels.length
          setPicked(p => (((p + (key === 'right' ? 1 : -1)) % n) + n) % n)
          return true
        }
        case 'ok': {
          if (e.repeat || press.current) return true
          const p = { long: false, timer: setTimeout(() => { p.long = true; setMenu(now.current.channels[now.current.picked]) }, LONG_PRESS_MS) }
          press.current = p
          return true
        }
      }
      return true
    }
    switch (key) {
      case 'down': if (first) { toRow(true); rowForced.current = false } return true
      case 'up': return true
      case 'back': hideControls(); return true
    }
  })

  // ---------- Drawing ----------

  const event = ch?.channels && ch.channels.length > 1 ? ch : undefined
  const playingName = event?.channels?.find(x => x.id === member)?.name
  const meta = ch ? (ch.state ? [ch.about, playingName].filter(Boolean).join('  ·  ') : metaOf(ch)) : ''

  // The row kept on the picked one.
  const strip = useRef<HTMLDivElement>(null)
  const [stripShift, setStripShift] = useState(0)
  useEffect(() => {
    // (As the Android TV's: the picked one a little in from the left.)
    const el = strip.current?.children[picked] as HTMLElement | undefined
    if (el) setStripShift(Math.max(0, el.offsetLeft - 48 - 120))
  }, [picked, shown])

  return (
    <div className="player lp">
      <div ref={box} className="player-box lp-box" />
      {stage.s !== 'playing' && ch && (
        <div className={`lp-stage ${stage.s}`}>
          <span className="lp-stage-glow" style={{ background: glow(ch.hue, 0x38, 230, '50%', '50%') }} />
          <div className="lp-stage-body">
            {stage.s === 'loading' && <span className="lp-spinner" />}
            <span className="lp-stage-eyebrow">{stage.eyebrow}</span>
            {stage.title && <b className="lp-stage-title">{stage.title}</b>}
            {stage.sub && <span className="lp-stage-sub">{stage.sub}</span>}
          </div>
        </div>
      )}
      <div className={`lp-info${infoOn ? ' on' : ''}`}>
        <span className="lp-top-shade" />
        {ch && (
          <div className="lp-name">
            <span className="lp-name-tile">
              <span className="lc-tint" style={{ background: glow(ch.hue, 0x5c, 60) }} />
              <NameTileArt c={ch} />
            </span>
            <span className="lp-name-text">
              <span className="lp-state"><i className="live-dot" />{state}</span>
              <b className="lp-title">{ch.name}</b>
              {meta && <span className="lp-meta">{meta}</span>}
            </span>
          </div>
        )}
        <span className="lp-clock"><Clock /></span>
        {shown && buttonsOn && ch && (
          <div ref={actions} className="lp-actions" data-scope={!panel && !inRow ? '' : undefined}>
            <Action icon={paused ? 'play' : 'pause'} label={paused ? 'Play' : 'Pause'} onClick={togglePause} />
            {event && <Action act="sources" icon="channels" label="Sources" onClick={() => setPanel(true)} />}
            <Action icon={ch.favourite ? 'star' : 'star_outline'} gold={ch.favourite} label={ch.favourite ? 'In My channels' : 'My channels'} onClick={() => toggleFavourite(index)} />
          </div>
        )}
      </div>
      <div className={`lp-strip${shown ? ' on' : ''}`}>
        <span className="lp-strip-title">{row}  ·  {picked + 1} of {channels.length}</span>
        <div className="lp-strip-scroll">
          <div ref={strip} className="lp-strip-items" style={{ transform: `translateX(${-stripShift}px)` }}>
            {channels.map((c, n) => (
              <span key={`${c.id}:${n}`} className={`lp-strip-item${n === picked ? ' picked' : ''}${n === picked && inRow ? ' lifted' : ''}`}>
                <ChannelTile c={c} small load={Math.abs(n - picked) < 10} />
              </span>
            ))}
          </div>
        </div>
        <span className={`lp-strip-keys${inRow ? ' on' : ''}`}>◀▶  Look along the row      OK  Watch{buttonsOn ? '      ▲  Back to the buttons' : ''}</span>
      </div>
      {panel && event?.channels && (
        <SourcesPanel channels={event.channels} member={member} onPick={id => {
          setPanel(false)
          backToSources()
          laterHide()
          if (id === member) return
          savePick(event, id)
          play(index, id)
        }} />
      )}
      {menu && <MyChannelsSheet card={menu} onToggle={() => toggleFavourite(channels.indexOf(menu))} onClose={() => setMenu(null)} />}
    </div>
  )
}

/** The name's tile: the logo, else (none, or it doesn't load) the short name. */
function NameTileArt({ c }: { c: LiveCard }) {
  const [broken, setBroken] = useState<string | null>(null)
  return c.logo && broken !== c.logo ? <img key={c.logo} src={c.logo} alt="" onError={() => setBroken(c.logo)} /> : <b>{c.mono}</b>
}

/** A button in the middle: a glass disc (white when focused, a soft light round it) and its label. */
function Action({ icon, label, onClick, gold, act }: { icon: 'play' | 'pause' | 'channels' | 'star' | 'star_outline'; label: string; onClick: () => void; gold?: boolean; act?: string }) {
  return (
    <button className="lp-act" data-f="" data-act={act} onClick={onClick}>
      <span className="lp-act-box">
        <span className="lp-halo" />
        <span className={`lp-disc${gold ? ' gold' : ''}`}><Icon name={icon} size={24} /></span>
      </span>
      <span className="lp-act-label">{label}</span>
    </button>
  )
}

/** An event's channels, popped up over its Sources button (as the player's Source panel), the one playing ticked. */
function SourcesPanel({ channels, member, onPick }: { channels: { id: string; name: string }[]; member: string; onPick: (id: string) => void }) {
  const list = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null)
  useEffect(() => {
    const b = document.querySelector<HTMLElement>('[data-act="sources"]')?.getBoundingClientRect()
    const stage = document.getElementById('root')?.getBoundingClientRect()
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize)
    if (b && stage) setPos({ left: Math.min((b.left - stage.left) / rem, 960 - 300 - 24), bottom: (stage.bottom - b.top) / rem + 10 })
    setTimeout(() => focusEl(list.current?.querySelector<HTMLElement>('[data-chosen]') ?? list.current?.querySelector<HTMLElement>('[data-f]')), 0)
  }, [])
  return (
    <div className="player-panel lp-panel" style={pos ? { left: `${pos.left}rem`, bottom: `${pos.bottom}rem` } : undefined} data-scope="">
      <b className="player-panel-title">Sources</b>
      <div ref={list} className="player-panel-list">
        {channels.map(c => (
          <button key={c.id} className="player-panel-row" data-f="" data-chosen={c.id === member ? '' : undefined} onClick={() => onPick(c.id)}>
            <span className="tick">{c.id === member ? '✓' : ''}</span>
            <span className="player-panel-text"><span>{c.name}</span></span>
          </button>
        ))}
      </div>
    </div>
  )
}
