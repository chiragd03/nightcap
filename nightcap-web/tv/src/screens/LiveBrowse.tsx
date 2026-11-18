import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { focus as focusEl } from '../focus'
import * as keyboard from '../keyboard'
import * as live from '../livetv'
import type { LiveCard } from '../livetv'
import { useKeys, useNav, useOnFront } from '../nav'
import LivePlayer from '../player/LivePlayer'
import Icon from '../ui/Icon'
import { notify } from '../ui/Notice'
import { ChannelTile, glow, MyChannelsSheet } from './LiveTv'
import './LiveTv.css'

// Browse all (as the Android TV's): a grid of the channels
// from the household's places (no filters for them here). From a kind's row (or its tile in More to
// explore) it's that kind, with a search; from Search every channel it's every kind, the search ready
// and the kinds on one line to pick from; from a household's own row, that row whole. More of the
// grid loads as you near its end. Also the channels that didn't play here (hidden), to try one again.

const COLUMNS = 5
const PAGE = 60
const TYPING_PAUSE_MS = 400
const LONG_PRESS_MS = 500

const LOADING = 'Loading channels…'

export default function LiveBrowse({ kind: startKind, row, rowTitle = '', search: searchMode, hidden: hiddenMode }: {
  kind?: string; row?: string; rowTitle?: string; search?: boolean; hidden?: boolean
}) {
  const nav = useNav()
  const root = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLInputElement>(null)
  const pills = useRef<HTMLDivElement>(null)
  const oneKind = startKind != null
  const [kind, setKind] = useState<string | undefined>(startKind)
  const [query, setQuery] = useState('')
  const [text, setText] = useState('')
  const [channels, setChannels] = useState<LiveCard[]>([])
  const [total, setTotal] = useState(0)
  const [last, setLast] = useState<live.LiveBrowse | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const shownCount = useRef(0)
  const [loading, setLoading] = useState(false)
  const [line, setLine] = useState(0)
  const [menu, setMenu] = useState<LiveCard | null>(null)
  const generation = useRef(0)
  const searching = !hiddenMode && row == null

  // Typing settles a moment before it's asked.
  useEffect(() => { const t = setTimeout(() => setQuery(text.trim()), TYPING_PAUSE_MS); return () => clearTimeout(t) }, [text])

  const ask = useCallback((offset: number, limit = PAGE): Promise<live.LiveBrowse> => {
    if (hiddenMode) return live.hidden().then(h => ({ channels: h.channels, count: h.channels.length, total: h.channels.length, offset: 0, hidden: h.channels.length, filters: {}, options: { kinds: [], countries: [], languages: [] } }))
    if (row != null) return live.browse({ row, offset, limit })
    return live.browse({ kind, q: query || undefined, offset, limit })
  }, [hiddenMode, row, kind, query])

  shownCount.current = channels.length
  const reload = useCallback(() => {
    const gen = ++generation.current
    setLoading(true)
    // (Nothing in the grid yet: say so, rather than an empty screen.)
    if (!shownCount.current) setStatus(LOADING)
    ask(0).then(b => {
      if (gen !== generation.current) return
      setLast(b); setChannels(b.channels); setTotal(b.count); setLine(0)
      setStatus(b.count > 0 ? null : hiddenMode ? 'Every channel plays again.' : row != null ? 'Nothing on in this row right now.'
        : query ? `No channel called “${query}” here.` : 'No channels here.')
    }, () => { if (gen === generation.current) setStatus("Couldn't reach the server. Try again in a moment.") })
      .finally(() => { if (gen === generation.current) setLoading(false) })
  }, [ask])
  useEffect(reload, [reload])

  // Focus: Search every channel's search, ready to type in; else the first channel once they're in.
  const placed = useRef(false)
  useEffect(() => {
    if (placed.current || !last) return
    placed.current = true
    setTimeout(() => {
      if (searchMode) focusEl(box.current)
      else focusEl(root.current?.querySelector<HTMLElement>('.lb-grid [data-at="0"]') ?? box.current)
    }, 0)
  }, [last])

  // Back from the player: a favourite may have changed, a hidden one may play now.
  const away = useRef(false)
  useOnFront(() => {
    if (!away.current) return
    away.current = false
    const gen = generation.current
    ask(0, Math.min(200, Math.max(PAGE, channels.length))).then(b => {
      if (gen !== generation.current) return
      if (hiddenMode) { setChannels(b.channels); setTotal(b.count); setStatus(b.count ? null : 'Every channel plays again.'); return }
      const byId = new Map(b.channels.map(c => [c.id, c]))
      setChannels(cs => cs.map(c => byId.get(c.id) ?? c))
    }, () => {})
  })

  const more = () => {
    if (loading || hiddenMode || channels.length >= total) return
    const gen = generation.current
    setLoading(true)
    ask(channels.length).then(b => { if (gen === generation.current) setChannels(cs => [...cs, ...b.channels]) }, () => {})
      .finally(() => { if (gen === generation.current) setLoading(false) })
  }

  const kinds = last?.options.kinds ?? []
  const kindName = kind ? kinds.find(k => k.id === kind)?.name : undefined
  const title = hiddenMode ? "Didn't play" : row != null ? rowTitle : kindName ?? (searchMode ? 'Search' : 'All channels')

  const open = (at: number) => {
    // Up and Down in the player go along what's loaded here, at most a row's worth either side.
    const from = Math.max(0, at - 30)
    const list = channels.slice(from, Math.min(channels.length, at + 30))
    const rowName = hiddenMode ? "Didn't play" : row != null ? rowTitle : kindName ?? (query ? `“${query}”` : 'All channels')
    away.current = true
    nav.push(<LivePlayer list={list} at={at - from} row={rowName} />)
  }
  const toggle = (c: LiveCard) => {
    const on = !c.favourite
    live.favourite(c.id, on).then(() => {
      setChannels(cs => cs.map(x => (x.id === c.id ? { ...x, favourite: on } : x)))
      notify(on ? 'Added to My channels' : 'Taken out of My channels')
    }, () => notify("Couldn't save that. Try again."))
  }

  // OK on a channel: short watches, held (500 ms) opens the My channels menu.
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; at: number; long: boolean } | null>(null)
  const latest = useRef(open)
  latest.current = open
  useEffect(() => {
    const up = (e: KeyboardEvent) => {
      if (e.keyCode !== 13 && e.key !== 'Enter') return
      const p = press.current
      if (!p) return
      press.current = null
      clearTimeout(p.timer)
      if (!p.long) latest.current(p.at)
    }
    window.addEventListener('keyup', up)
    return () => window.removeEventListener('keyup', up)
  }, [])

  const lit = () => root.current?.querySelector<HTMLElement>('.lb-pill.lit') ?? root.current?.querySelector<HTMLElement>('.lb-pill')

  useKeys((key, e) => {
    if (menu) return
    const a = document.activeElement as HTMLElement | null
    const lost = !a || a === document.body || !root.current?.contains(a)
    if (searching && (a === box.current || (lost && key !== 'ok'))) {
      if (key === 'ok') {
        if (!keyboard.typing(box.current)) return
        e.preventDefault()
        focusEl(root.current?.querySelector<HTMLElement>('.lb-grid [data-at="0"]'))
        return true
      }
      if (key === 'down') { focusEl(lit() ?? root.current?.querySelector<HTMLElement>('.lb-grid [data-at="0"]')); return true }
      if (key === 'up') { if (lost) focusEl(box.current); return true }
      return
    }
    const at = a?.dataset.at
    if (at == null) return
    const i = Number(at)
    if (key === 'ok') {
      if (e.repeat || press.current) return true
      const c = channels[i]
      if (!c) return true
      const p = { at: i, long: false, timer: setTimeout(() => { p.long = true; setMenu(c) }, LONG_PRESS_MS) }
      press.current = p
      return true
    }
    // The top line goes up to the kind shown on the line of kinds, else to the search.
    if (key === 'up' && i < COLUMNS) {
      const to = lit() ?? (searching ? box.current : null)
      if (to) focusEl(to)
      return true
    }
    if (key === 'right' && (i % COLUMNS === COLUMNS - 1 || i === channels.length - 1)) return true
    if (key === 'left' && i % COLUMNS === 0) return true
    if (key === 'down' && i + COLUMNS >= channels.length) return true
  })

  // The line in focus moves up (the grid slides) and those above fade under the search; more come
  // as it nears the end.
  const grid = useRef<HTMLDivElement>(null)
  const [shift, setShift] = useState(0)
  useLayoutEffect(() => {
    const el = grid.current?.children[line] as HTMLElement | undefined
    const top = grid.current?.children[0] as HTMLElement | undefined
    setShift(el && top && line > 0 ? el.offsetTop - top.offsetTop : 0)
  }, [line, channels.length])
  useEffect(() => { if ((line + 3) * COLUMNS >= channels.length) more() }, [line, channels.length])

  // The line of kinds kept in sight as focus moves along it.
  const [pillShift, setPillShift] = useState(0)
  // (Only as far as it takes to keep the focused one in, inside the page's 48 margins.)
  const onPill = (el: HTMLElement) => {
    const s = pills.current
    if (!s) return
    const w = s.clientWidth, left = el.offsetLeft, right = left + el.offsetWidth
    setPillShift(x => (right - x > w - 48 ? right - w + 48 : left - x < 48 ? Math.max(0, left - 48) : x))
  }

  const lines: LiveCard[][] = []
  for (let i = 0; i < channels.length; i += COLUMNS) lines.push(channels.slice(i, i + COLUMNS))
  const showPills = searching && (!oneKind || (last?.hidden ?? 0) > 0)

  return (
    <div ref={root} className="screen live-browse">
      <span className="lb-glow" style={{ background: glow(220, 0x26, 320, '85%', '10%') }} />
      <div className="lb-main" data-inert={menu ? '' : undefined}>
        <div className="lb-head">
          <span className="lb-titles">
            <span className="lb-eyebrow">LIVE TV</span>
            <b className="lb-title">{title}</b>
          </span>
          <span className="lb-count">{total > 0 ? (total === 1 ? '1 channel' : `${total.toLocaleString()} channels`) : ''}</span>
        </div>
        {searching && (
          <label className="lb-search">
            <Icon name="search" size={16} />
            <input ref={box} data-f="" value={text} placeholder={`Search ${(kindName ?? 'channels').toLowerCase()}`}
              spellCheck={false} autoComplete="off" autoCorrect="off" onChange={e => setText(e.target.value)} onFocus={() => setLine(0)} />
          </label>
        )}
        {showPills && (
          <div ref={pills} className="lb-pills">
            <div className="lb-pills-track" style={{ transform: `translateX(${-pillShift}px)` }}>
              {!oneKind && [{ id: '', name: 'All', count: 1 }, ...kinds.filter(k => k.count > 0)].map(k => {
                const on = (kind ?? '') === k.id
                return <button key={k.id || 'all'} className={`lb-pill${on ? ' lit' : ''}`} data-f="" onFocus={e => { setLine(0); onPill(e.currentTarget) }}
                  onClick={() => { if (!on) setKind(k.id || undefined) }}>{k.name}</button>
              })}
              {(last?.hidden ?? 0) > 0 && (
                <button className="lb-pill" data-f="" onFocus={e => onPill(e.currentTarget)} onClick={() => nav.push(<LiveBrowse hidden />)}>Didn't play · {last!.hidden}</button>
              )}
            </div>
          </div>
        )}
        {hiddenMode && <p className="lb-note">Hidden for a week, then tried again on their own. Play one: if it plays, it's back now.</p>}
        <div className="lb-grid-wrap">
          <div ref={grid} className="lb-grid" style={{ transform: `translateY(${-shift}px)` }}>
            {lines.map((cs, n) => (
              <div key={n} className={`lb-line${n < line ? ' above' : ''}`}>
                {cs.map((c, k) => {
                  const at = n * COLUMNS + k
                  // Own items keep their "about" or start line; ordinary channels show language · country.
                  const sub = c.state ? undefined : [c.languages[0]?.name, c.countries[0]?.name].filter(Boolean).join(' · ')
                  return (
                    <button key={`${c.id}:${at}`} className="card lb-card" data-f="" data-at={at} onFocus={() => setLine(n)} onClick={() => open(at)}>
                      <ChannelTile c={c} sub={sub} load={Math.abs(n - line) < 6} />
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
        </div>
      </div>
      {status && <p className={`lb-status${status === LOADING ? ' waiting' : ''}`} role="status">{status}</p>}
      {menu && <MyChannelsSheet card={menu} onToggle={() => toggle(menu)} onClose={() => setMenu(null)} />}
    </div>
  )
}
