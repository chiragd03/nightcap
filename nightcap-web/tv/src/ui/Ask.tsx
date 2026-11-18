import { useEffect, useRef, useState } from 'react'
import * as api from '../api'
import { focus } from '../focus'
import { useKeys, useNav } from '../nav'
import { closePlaying, pauseForQuestion, questionClosed, resumeAfterQuestion } from '../playing'
import * as profiles from '../profiles'
import type { Profile } from '../profiles'
import LinkPlayer from '../player/LinkPlayer'
import Player from '../player/Player'
import * as store from '../store'
import Icon from './Icon'
import { notify } from './Notice'
import './Ask.css'

// Play on TV: while the app is open, in a household
// and someone's watching, it asks the server every 10 s whether a phone sent something. If so, over
// whatever screen is open: "{Name} wants to play", with Play (as them, if it's someone else) and
// Not now. What's playing pauses while it asks. No answer in 60 s: declined. (The Android TV also
// checks while another app is in front and brings itself forward; a web app can't.)

const EVERY_MS = 10_000
const ANSWER_WITHIN_MS = 60_000
/** An answer that didn't get through: sent once more after this. */
const ANSWER_AGAIN_MS = 2_000

type Request = {
  id: string
  title?: { type: string; id: string; name: string; episode?: string; art?: string }
  link?: { url: string; name?: string; site?: string }
  from: Profile
}

/** A link said yes to is being added: the inbox isn't asked meanwhile (its request is still unanswered
 * until the add is done, and would be asked again), as on Android. */
let addingLink = false

export default function Ask() {
  const [req, setReq] = useState<Request | null>(null)
  const asking = useRef(false)
  asking.current = !!req

  useEffect(() => {
    const check = () => {
      if (asking.current || addingLink || document.visibilityState !== 'visible' || !store.ready() || !profiles.currentId()) return
      api.call<{ request?: Request }>('/launcher/inbox.json').then(r => {
        if (r.request && !asking.current) setReq(r.request)
      }, () => {})
    }
    const t = setInterval(check, EVERY_MS)
    return () => clearInterval(t)
  }, [])

  return req ? <Question key={req.id} req={req} onDone={() => setReq(null)} /> : null
}

/** The answer to the server (once more after a moment if the network blinked: the phone is waiting on it). */
function reply(id: string, accept: boolean) {
  const path = `/launcher/inbox/${encodeURIComponent(id)}/answer`
  api.call(path, { body: { accept } }).catch(() => {
    setTimeout(() => { api.call(path, { body: { accept } }).catch(() => {}) }, ANSWER_AGAIN_MS)
  })
}

function Question({ req, onDone }: { req: Request; onDone: () => void }) {
  const nav = useNav()
  const opener = useRef(document.activeElement as HTMLElement | null)
  const playButton = useRef<HTMLButtonElement>(null)
  const wasPlaying = useRef(false)
  const done = useRef(false)
  const a = profiles.avatar(req.from)
  const asOther = !!req.title && req.from.id !== profiles.currentId()

  useEffect(() => {
    wasPlaying.current = pauseForQuestion()
    focus(playButton.current)
    // Unanswered: declined (and what was paused stays paused, as on Android).
    const t = setTimeout(() => answer(false, false), ANSWER_WITHIN_MS)
    // (However the question goes, the player's keys come back to it.)
    return () => { clearTimeout(t); questionClosed() }
  }, [])

  const close = () => { questionClosed(); focus(opener.current); onDone() }

  function answer(accept: boolean, resume = true) {
    if (done.current) return
    done.current = true
    // (A link is said yes to once it's been added; a title at once.)
    if (!accept || !req.link || req.title) reply(req.id, accept)
    close()
    if (!accept) { if (resume && wasPlaying.current) resumeAfterQuestion(); return }
    if (req.title) {
      // What's playing closes first, its place saved for the one who was watching it; then as the sender,
      // and staying them.
      closePlaying()
      if (asOther) profiles.choose(profiles.list().find(p => p.id === req.from.id) ?? req.from)
      const t = req.title
      nav.push(<Player type={t.type === 'series' ? 'series' : 'movie'} id={t.id} name={t.name} episode={t.episode} art={t.art} />)
      return
    }
    if (req.link) {
      const site = req.link.site
      addingLink = true
      api.post<{ id: string; url: string; name?: string; position?: number; duration?: number }>('/launcher/sent', { url: req.link.url, ...(req.link.name ? { name: req.link.name } : {}) }).then(
        got => {
          addingLink = false
          reply(req.id, true)
          closePlaying()
          nav.push(<LinkPlayer id={got.id} url={got.url} name={got.name ?? site ?? 'A video'}
            position={got.duration && got.position && got.duration - got.position < 30_000 ? 0 : got.position ?? 0} />)
        },
        () => { addingLink = false; reply(req.id, false); notify("Couldn't play that link.") })
    }
  }

  useKeys(key => {
    if (key === 'back') { answer(false); return true }
    if (key === 'up' || key === 'down') return true
  })

  const what = req.title?.name ?? req.link?.name ?? 'A video'
  const detail = req.title?.episode ?? req.link?.site ?? ''
  return (
    <div className="sheet-dim ask-dim">
      <div className="ask" data-scope="" role="dialog" aria-label={`${req.from.name} wants to play`}>
        {req.title?.art && <span className="ask-art"><img src={req.title.art} alt="" /></span>}
        <div className="ask-body">
          <span className="ask-from">
            <span className="pin-disc" style={{ background: a.tint }}><img src={profiles.avatarSrc(a.image)} alt="" /></span>
            {req.from.name} wants to play
          </span>
          <b className="ask-what">{what}</b>
          {detail && <span className="ask-detail">{detail}</span>}
          <div className="ask-choices">
            <button ref={playButton} className="sheet-item" data-f="" onClick={() => answer(true)}>
              <Icon name="play" size={16} /> {asOther ? `Play as ${req.from.name}` : 'Play'}
            </button>
            <button className="sheet-item" data-f="" onClick={() => answer(false)}><Icon name="act_close" size={16} /> Not now</button>
          </div>
        </div>
      </div>
    </div>
  )
}
