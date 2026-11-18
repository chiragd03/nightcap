import { useCallback, useEffect, useState, type CSSProperties, type FormEvent } from 'react'
import * as api from '../api'
import Menu, { type Action } from '../components/Menu'
import { useNotice } from '../components/Notice'
import PlayOnTv from '../components/PlayOnTv'
import './Sent.css'
import Img from '../components/Img'
import Problem from '../components/Problem'
import Waiting from '../components/Waiting'
import { errorWords } from '../errors'

// Links played on the TV: any video or .m3u8 address, kept per profile with how far it got and a
// picture the TV grabbed. Send a new one to a TV from the bar on top; click one to play it there
// again (it resumes where it got to). The TV plays a link on its own profile.

export default function Sent() {
  const [items, setItems] = useState<api.SentLink[]>()
  const [error, setError] = useState<unknown>()
  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const [onTv, setOnTv] = useState<{ url: string; name: string }>()
  const [menu, setMenu] = useState<{ title: string; subtitle?: string; actions: Action[] }>()
  const [notice, notify] = useNotice()

  const reload = useCallback(() => api.sentLinks().then(i => { setItems(i); setError(undefined) }, setError), [])
  useEffect(() => { reload() }, [reload])

  const clean = url.trim()
  const valid = /^https?:\/\/\S+$/i.test(clean)
  const send = (e: FormEvent) => {
    e.preventDefault()
    if (valid) setOnTv({ url: clean, name: name.trim() || siteOf(clean) })
  }

  const remove = (it: api.SentLink) => setMenu({
    title: `Remove ${it.name}?`, subtitle: 'It leaves this list; nothing else changes.',
    actions: [
      { icon: 'act_remove', label: 'Remove', run: () => api.removeSent(it.id).then(() => { notify('Removed'); reload() }, () => notify("Couldn't remove that. Try again.")) },
      { icon: 'act_close', label: 'Keep', run: () => {} },
    ],
  })

  return (
    <div className="sent">
      <header className="sent-head">
        <span className="eyebrow">Links on the TV</span>
        <h1>Sent to TV</h1>
        <p>Any video or .m3u8 link. The TV plays it on whichever profile is on it, and remembers how far it got.</p>
      </header>

      <form className="sent-bar" onSubmit={send}>
        <input value={url} onChange={e => setUrl(e.target.value)} placeholder="Paste a video or .m3u8 link" aria-label="Link"
          inputMode="url" spellCheck={false} autoComplete="off" />
        <input className="sent-name" value={name} onChange={e => setName(e.target.value)} placeholder="Name (optional)" aria-label="Name" maxLength={80} autoComplete="off" />
        <button className="btn primary" disabled={!valid}>Play on TV</button>
      </form>
      {clean && !valid && <p className="sent-hint">A link starts with http:// or https://</p>}

      {error && !items ? <Problem words={errorWords(error)} retry={() => { setError(undefined); reload() }} autoRetry />
        : !items ? <Waiting after={300} />
        : items.length === 0 ? <p className="sent-empty">Nothing yet. Links you send to the TV show here, with where they got to.</p>
        : (
          <div className="sent-grid">
            {items.map((it, i) => <Tile key={it.id} item={it} i={i} onPlay={() => setOnTv({ url: it.url, name: it.name })} onRemove={() => remove(it)} />)}
          </div>
        )}

      {onTv && <PlayOnTv what={{ link: onTv }} name={onTv.name} onClose={() => { setOnTv(undefined); reload() }} />}
      {menu && <Menu {...menu} onClose={() => setMenu(undefined)} />}
      {notice}
    </div>
  )
}

const MARK = `${import.meta.env.BASE_URL}brand/mark.png`

function Tile({ item, i, onPlay, onRemove }: { item: api.SentLink; i: number; onPlay: () => void; onRemove: () => void }) {
  const [thumb, setThumb] = useState<string>()
  useEffect(() => {
    if (!item.thumb) return
    let url: string | undefined
    api.sentThumb(item.id).then(u => { url = u; setThumb(u) }, () => {})
    return () => { if (url) URL.revokeObjectURL(url) }
  }, [item.id, item.thumb])
  const progress = item.duration ? Math.min(1, item.position / item.duration) : 0
  const site = siteOf(item.url)
  return (
    <div className="sent-tile" style={{ '--i': i, '--hue': hueOf(site) } as CSSProperties}>
      <button className="sent-still" onClick={onPlay} aria-label={`Play ${item.name} on TV`}>
        {/* (A link with no picture of its own, say a direct video file: Nightcap's mark.) */}
        <Img src={thumb} lazy={false} fallback={<img className="sent-mark" src={MARK} alt="" />} />
        <span className="sent-play">▶ Play on TV</span>
        {progress > 0 && <span className="sent-progress"><span style={{ width: `${progress * 100}%` }} /></span>}
      </button>
      <div className="sent-info">
        <span className="sent-text">
          <b title={item.name}>{item.name}</b>
          <small>{site} · {item.position > 0 ? `at ${clock(item.position)}${item.duration ? ` of ${clock(item.duration)}` : ''}` : 'not started'}</small>
          <small>Sent {ago(item.sent_at)}{item.played_at ? ` · played ${ago(item.played_at)}` : ''}</small>
        </span>
        <button className="sent-remove" aria-label={`Remove ${item.name}`} onClick={onRemove}>⋯</button>
      </div>
    </div>
  )
}

const siteOf = (url: string) => { try { return new URL(url).hostname } catch { return url } }
function hueOf(s: string) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h }
function clock(ms: number) {
  const t = Math.floor(ms / 1000), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
}
function ago(sec: number) {
  const s = Date.now() / 1000 - sec
  if (s < 90) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} minutes ago`
  if (s < 86400) return `${Math.round(s / 3600)} hours ago`
  if (s < 2 * 86400) return 'yesterday'
  return new Date(sec * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}
