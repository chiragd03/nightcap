import { useEffect, useRef, useState } from 'react'
import * as api from '../api'
import { useKeys, useNav, usePlayerScreen } from '../nav'
import { holdAwake, holdSeeThrough, isAsking, setPlaying } from '../playing'
import { later } from '../ui/Notice'
import { createEngine, type Engine } from './engine'
import { clock } from './sources'
import './Player.css'

// A link sent with Play on TV: played full screen, kept
// in the profile's history with where it got to (every 10 s, and on leaving). Left and Right go 10 s
// back and forward; OK pauses; Back leaves. HLS and plain files both play on the TVs' own players.
// (The Android TV grabs a frame for the history's picture: a web app can't read the video's pixels.)

const STEP_MS = 10_000
const SAVE_EVERY_MS = 10_000

export default function LinkPlayer({ id, url, name, position }: { id: string; url: string; name: string; position: number }) {
  const nav = useNav()
  // (A note left for later waits for the screen after it.)
  usePlayerScreen()
  const box = useRef<HTMLDivElement>(null)
  const engine = useRef<Engine | null>(null)
  const [time, setTime] = useState(0)
  const [length, setLength] = useState(0)
  const [shown, setShown] = useState(true)
  const [loading, setLoading] = useState(true)
  const hide = useRef<ReturnType<typeof setTimeout>>(undefined)
  const showFor = () => { setShown(true); clearTimeout(hide.current); hide.current = setTimeout(() => setShown(false), 3000) }

  // (Closed for Play on TV: saved then, under the profile that watched it, and not again.)
  const closed = useRef(false)
  const save = () => {
    const e = engine.current
    if (closed.current || !e || e.time() <= 0) return
    api.send(`/launcher/sent/${encodeURIComponent(id)}/progress`, { position: Math.round(e.time()), duration: Math.round(e.length()) })
  }

  useEffect(() => {
    let gone = false
    const letGo = [holdSeeThrough(), holdAwake()]
    createEngine(box.current!, {
      playing: () => { setLoading(false); showFor() },
      paused: () => setShown(true),
      time: setTime, length: setLength, buffering: () => {},
      ended: () => { save(); nav.pop() },
      error: () => { later("Couldn't play this link."); nav.pop() },
      tracks: () => {}, cue: () => {},
    }).then(e => {
      // (Closed for Play on TV meanwhile: nothing opens.)
      if (gone || closed.current) return e.destroy()
      engine.current = e
      e.open(url, position > 5000 ? position : 0, /\.m3u8($|\?)/i.test(url))
    })
    const unregister = setPlaying({
      pause: () => { const e = engine.current; if (!e || e.isPaused()) return false; e.pause(); return true },
      resume: () => engine.current?.play(),
      close: () => { save(); closed.current = true; engine.current?.stop(); nav.pop() },
    })
    const t = setInterval(save, SAVE_EVERY_MS)
    const onHide = () => { if (document.visibilityState === 'hidden') save() }
    document.addEventListener('visibilitychange', onHide)
    return () => {
      gone = true
      save()
      clearInterval(t)
      document.removeEventListener('visibilitychange', onHide)
      unregister()
      for (const f of letGo) f()
      engine.current?.destroy()
    }
  }, [])

  useKeys(key => {
    // (Play on TV asking over the link: the keys are its question's.)
    if (isAsking()) return
    const e = engine.current
    if (key === 'back') { nav.pop(); return true }
    if (!e) return true
    if (key === 'left' || key === 'rw') { e.seek(Math.max(0, e.time() - STEP_MS)); showFor(); return true }
    if (key === 'right' || key === 'ff') { e.seek(e.time() + STEP_MS); showFor(); return true }
    if (key === 'ok' || key === 'playpause' || key === 'play' || key === 'pause') { e.isPaused() ? e.play() : e.pause(); showFor(); return true }
    showFor()
    return true
  })

  return (
    <div className="player">
      <div ref={box} className="player-box" />
      {loading && <div className="player-loading"><div className="player-loading-text"><b className="player-name">{name}</b><span className="player-status">Opening…</span></div></div>}
      <div className={`player-controls${shown && !loading ? ' shown' : ''}`}>
        <span className="player-shade" />
        <div className="player-controls-body">
          <b className="player-title">{name}</b>
          <div className="timeline"><span className="timeline-track"><span className="timeline-fill" style={{ transform: `scaleX(${length ? Math.min(1, time / length) : 0})` }} /></span></div>
          <div className="timeline-numbers"><span>{clock(time)}</span><span>{length ? `−${clock(length - time)}` : 'Live'}</span></div>
        </div>
      </div>
    </div>
  )
}
