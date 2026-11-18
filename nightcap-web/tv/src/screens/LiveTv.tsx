import { useCallback, useEffect, useRef, useState } from 'react'
import { focus as focusEl } from '../focus'
import { Clock } from '../home/Widgets'
import * as live from '../livetv'
import type { LiveCard, LivePage } from '../livetv'
import { useIsFront, useKeys, useNav, useOnFront } from '../nav'
import LivePlayer from '../player/LivePlayer'
import Aura from '../ui/Aura'
import { CardRows, useCardRows, type RowOf } from '../ui/CardRows'
import Icon from '../ui/Icon'
import { notify } from '../ui/Notice'
import Rail, { homePage, type Entry } from '../ui/Rail'
import Sheet from '../ui/Sheet'
import Tile from '../ui/Tile'
import LiveBrowse from './LiveBrowse'
import Profiles from './Profiles'
import Search from './Search'
import Settings from './Settings'
import '../home/Home.css'
import './LiveTv.css'

// Live TV (as the Android TV's): like Home, the focused channel on top
// (its colour and logo top right, then after a rest its live picture, muted) and rows below: My
// channels first (only with some), the household's own rows, then the first six kinds, each ending
// in Browse all; then More to explore, a tile for every other kind; last, Search every channel, one
// wide panel. OK watches; a long press opens the My channels menu. Left on a row's first card opens
// the side panel. With no channel list yet: a soft glow, what Live TV needs, and two glass tiles.

const KIND_ROWS = 6
const PREVIEW_AFTER_MS = 2_500
/** A first load that failed: asked again after this. */
const RELOAD_MS = 10_000
const EMPTY_TINT = '#2E3F7A'
const HOME_TINT = '#4A3A78'

/** A tile in a row: a channel, a row's Browse all, a kind (More to explore), or Search every channel. */
export type Item =
  | { id: string; type: 'channel'; card: LiveCard; row: { title: string; channels: LiveCard[] } }
  | { id: string; type: 'all'; title: string; count: number; to: { kind?: string; row?: string } }
  | { id: string; type: 'kind'; name: string; count: number; kind: string; logos: string[] }
  | { id: string; type: 'every'; count: number; logos: string[] }

type Menu = { card: LiveCard }

const LOADING = 'Loading Live TV…'

export default function LiveTv() {
  const nav = useNav()
  const front = useIsFront()
  const root = useRef<HTMLDivElement>(null)
  const [page, setPage] = useState<LivePage>()
  const [kinds, setKinds] = useState<{ id: string; name: string; count: number }[]>([])
  const [status, setStatus] = useState<string | null>(null)
  const [rail, setRail] = useState(false)
  const [menu, setMenu] = useState<Menu | null>(null)
  const [tint, setTint] = useState(EMPTY_TINT)
  const checking = useRef(false)
  const reload = useRef<ReturnType<typeof setTimeout>>(undefined)
  const frontNow = useRef(front)
  frontNow.current = front

  const load = useCallback(() => {
    clearTimeout(reload.current)
    // (Nothing on screen yet: say so, rather than a blank page.)
    if (!page) setStatus(LOADING)
    Promise.all([live.page(), live.browse({ limit: 1 }).then(r => r.options.kinds, () => null)]).then(([p, k]) => {
      if (k) setKinds(k)
      setPage(p)
      setStatus(null)
      if (p.lists === 0 && checking.current) notify('No channel list yet. Add one on the web, then check again.')
      checking.current = false
    }, e => {
      checking.current = false
      if (!page) {
        const notOnServer = e instanceof Error && /404/.test(e.message)
        setStatus(notOnServer ? "This Nightcap server doesn't have Live TV yet." : "Couldn't reach the server. Try again in a moment.")
        // (Asked again by itself while this screen is up; leaving it drops that.)
        if (!notOnServer && frontNow.current && document.visibilityState === 'visible')
          reload.current = setTimeout(() => { if (document.visibilityState === 'visible') load() }, RELOAD_MS)
      }
    })
  }, [page])
  // Each time it comes to the front (back from the player: My channels may have changed).
  useOnFront(load)
  useEffect(() => { if (!front) clearTimeout(reload.current) }, [front])
  useEffect(() => () => clearTimeout(reload.current), [])

  const rows = page && page.lists > 0 ? rowsOf(page, kinds) : []

  const open = (rowIndex: number, i: number) => {
    const it = rows[rowIndex]?.items[i]
    if (!it) return
    if (it.type === 'all') return nav.push(<LiveBrowse kind={it.to.kind} row={it.to.row} rowTitle={it.title} />)
    if (it.type === 'kind') return nav.push(<LiveBrowse kind={it.kind} />)
    if (it.type === 'every') return nav.push(<LiveBrowse search />)
    const c = it.card
    if (c.state === 'upcoming') return notify(`${c.name} · ${c.startsAt ? `Starts ${live.timeText(c.startsAt)}` : "Hasn't started yet"}`)
    const list = it.row.channels
    nav.push(<LivePlayer list={list} at={Math.max(0, list.findIndex(x => x.id === c.id))} row={it.row.title} />)
  }

  const r = useCardRows({
    root, rows, front: front && !menu && !rail,
    onOpen: open,
    hasMenu: (rr, i) => rows[rr]?.items[i]?.type === 'channel',
    onMenu: (rr, i) => { const it = rows[rr]?.items[i]; if (it?.type === 'channel') setMenu({ card: it.card }) },
    onLeftEdge: () => setRail(true),
  })
  // The first card once the page is in.
  const placed = useRef(false)
  useEffect(() => { if (rows.length && !placed.current) { placed.current = true; r.focusCard(0, 0) } }, [rows.length])

  useKeys((key, e) => {
    if (rail || menu) return
    return r.onKey(key, e)
  })

  const pickRail = (entry: Entry) => {
    setRail(false)
    if (entry === 'live') return setTimeout(() => r.focusCard(0, 0), 0)
    const page = homePage(entry)
    if (page) return nav.popToRoot(page)
    if (entry === 'profile') return nav.push(<Profiles fromMenu />)
    nav.push(entry === 'search' ? <Search /> : <Settings />)
  }

  const toggle = (c: LiveCard) => {
    const on = !c.favourite
    live.favourite(c.id, on).then(() => { notify(on ? 'Added to My channels' : 'Taken out of My channels'); load() },
      () => notify("Couldn't save that. Try again."))
  }

  // No channel list yet.
  if (page && page.lists === 0) {
    return (
      <div ref={root} className="home live">
        <Aura tint={tint} />
        <div className={`dims${rail ? ' dim' : ''}`} data-inert={rail ? '' : undefined}>
          <span className={`home-hint${rail ? ' hidden' : ''}`}>‹  Live TV</span>
          <div className="live-empty">
            <b className="live-empty-title">No channels yet</b>
            <p className="live-empty-hint">Live TV shows channels from your household's channel lists.{'\n'}Ask your household's admin to add one.</p>
            <div className="tiles live-empty-tiles">
              <span onFocus={() => setTint(EMPTY_TINT)}>
                <Tile label="Already added one?" name="Check again" sub="Look for channels now" icon="nav_live" autoFocus first
                  onClick={() => { checking.current = true; load() }} />
              </span>
              <span onFocus={() => setTint(HOME_TINT)}>
                <Tile label="Meanwhile" name="Home" sub="Back to your titles" icon="nav_home" onClick={() => nav.popToRoot()} />
              </span>
            </div>
          </div>
        </div>
        <Rail open={rail} page="live" onClose={() => setRail(false)} onPick={pickRail} />
        <EmptyKeys onLeft={() => setRail(true)} active={!rail} />
      </div>
    )
  }

  const row = rows[r.focus.row]
  const it = row?.items[Math.min(r.focus.at[row.id] ?? 0, row.items.length - 1)]
  // Before anything's focused: the channel watched last, else the first.
  const first = page?.hero ?? page?.rows.find(x => x.channels.length)?.channels[0]

  return (
    <div ref={root} className="home live">
      {page && <Hero item={it} fallback={first} last={!it && !!page.hero} active={front && !rail && !menu} />}
      <div className={`dims${rail ? ' dim' : ''}`} data-inert={rail || menu ? '' : undefined}>
        <span className={`home-hint${rail ? ' hidden' : ''}`}>‹  Live TV</span>
        <Clock />
        {rows.length > 0 && (
          <CardRows className="live-rows" rows={rows} focus={r.focus} onFocusCard={r.onFocusCard}
            onPick={(rr, i) => { if (rows[rr]?.items[i]?.type !== 'channel') open(rr, i) }}
            card={(_rw, x, _i, load) => <LiveTile item={x} load={load} />} />
        )}
      </div>
      {status && <p className={`home-status${status === LOADING ? ' waiting' : ''}`} role="status">{status}</p>}
      <Rail open={rail} page="live" onClose={() => setRail(false)} onPick={pickRail} />
      {menu && <MyChannelsSheet card={menu.card} onToggle={() => toggle(menu.card)} onClose={() => setMenu(null)} />}
    </div>
  )
}

/** The page's rows, as the Android TV's. */
function rowsOf(page: LivePage, kinds: { id: string; name: string; count: number }[]): RowOf<Item>[] {
  const counts = new Map(kinds.map(k => [k.id, k.count]))
  const count = (x: LivePage['rows'][number]) => (x.count && x.count > 0 ? x.count : (x.kind && counts.get(x.kind)) || x.channels.length)
  const channels = (x: LivePage['rows'][number]): Item[] => x.channels.map((c, n) => ({ id: `${c.id}#${n}`, type: 'channel', card: c, row: x }))
  const rest = page.rows.filter(x => x.key !== 'mine' && x.channels.length)
  let kindRows = 0
  const shown = rest.filter(x => !!x.row || !x.kind || ++kindRows <= KIND_ROWS)
  const later = rest.filter(x => !shown.includes(x))
  const out: RowOf<Item>[] = []
  for (const x of page.rows) if (x.key === 'mine' && x.channels.length) out.push({ id: x.key, title: x.title, kind: 'live', items: channels(x) })
  for (const x of shown) {
    out.push({ id: x.key, title: x.title, kind: 'live', items: [...channels(x), { id: '#browse', type: 'all', title: x.title, count: count(x), to: x.row ? { row: x.key } : { kind: x.kind } }] })
  }
  const explore: Item[] = [
    ...later.map(x => ({ id: `kind:${x.kind ?? x.key}`, type: 'kind' as const, name: x.title, count: count(x), kind: x.kind ?? x.key, logos: x.channels.flatMap(c => (c.logo ? [c.logo] : [])) })),
    ...kinds.filter(k => k.count > 0 && !rest.some(x => x.kind === k.id)).map(k => ({ id: `kind:${k.id}`, type: 'kind' as const, name: k.name, count: k.count, kind: k.id, logos: [] })),
  ]
  if (explore.length) out.push({ id: 'explore', title: 'More to explore', kind: 'live', items: explore })
  const logos = Array.from(new Set(page.rows.flatMap(x => x.channels.flatMap(c => (c.logo ? [c.logo] : [])))))
  out.push({ id: 'every', title: '', kind: 'every', items: [{ id: '#every', type: 'every', count: page.shown, logos }] })
  return out
}

const channelsText = (n: number) => `${n.toLocaleString()} ${n === 1 ? 'channel' : 'channels'}`

/** The top: what the focused tile is (a channel: its colour and logo, then its live picture, muted). */
function Hero({ item, fallback, last, active }: { item?: Item; fallback?: LiveCard; last: boolean; active: boolean }) {
  const c = item ? (item.type === 'channel' ? item.card : undefined) : fallback
  let eyebrow: string, title: string, meta: string, reason: string, hue: number
  if (c) {
    eyebrow = c.state === 'upcoming' ? 'Upcoming' : last ? 'Live · Last watched' : 'Live'
    title = c.name
    meta = c.about ?? metaOf(c)
    reason = c.state === 'upcoming' && c.startsAt ? `Starts ${live.timeText(c.startsAt)}`
      : c.channels && c.channels.length > 1 ? `${c.channels.length} channels · ${c.channels.map(x => x.name).join(', ')}`
      : last ? 'Press OK to carry on watching' : c.favourite ? 'In My channels' : ''
    hue = c.hue
  } else if (item?.type === 'all') {
    eyebrow = 'Browse all'; title = item.title; meta = channelsText(item.count); reason = 'Press OK for the whole row'; hue = 220
  } else if (item?.type === 'kind') {
    eyebrow = 'More to explore'; title = item.name; meta = channelsText(item.count); reason = 'Press OK to see them all'; hue = live.hueOf(item.kind)
  } else if (item?.type === 'every') {
    eyebrow = 'Every channel'; title = 'Search'; meta = channelsText(item.count); reason = 'By name, or look through every kind'; hue = 40
  } else return null
  const key = c?.id ?? item?.id
  return (
    <>
      <div className="live-art-frame" style={{ visibility: c ? 'visible' : 'hidden' }}>
        <span className="live-art-glow" style={{ background: glow(hue, 0x66, 420) }} />
        {c?.logo && <img key={c.logo} className="live-art-logo" src={c.logo} alt="" />}
        {c && <Preview key={c.id} c={c} active={active} />}
        <span className="scrim-left" />
        <span className="scrim-bottom" />
      </div>
      <div key={key} className="live-hero">
        <span className="live-hero-eyebrow"><i className="live-dot" />{eyebrow}</span>
        <b className="live-hero-title">{title}</b>
        {meta && <span className="live-hero-meta">{meta}</span>}
        {reason && <span className="live-hero-reason">{reason}</span>}
      </div>
    </>
  )
}

/** A channel's live picture, muted, after a rest (an ordinary, live or 24/7 one; not one that hasn't
 *  started); nothing if it doesn't play (that isn't counted as failing). Where the TV can play HLS
 *  in the page (hls.js over Media Source, or its own): LG, a browser. */
function Preview({ c, active }: { c: LiveCard; active: boolean }) {
  const box = useRef<HTMLDivElement>(null)
  const [on, setOn] = useState(false)
  useEffect(() => {
    if (!active || (c.state && c.state !== 'live' && c.state !== '24/7')) return
    let gone = false, hls: { destroy(): void } | null = null, v: HTMLVideoElement | null = null
    const t = setTimeout(() => {
      live.play(c.id).then(async p => {
        const s = p.streams.find(x => !x.recipe) ?? p.streams[0]
        if (gone || !s || !box.current) return
        let got: { url: string; hls?: object } | null = { url: s.url }
        if (s.recipe) {
          const { handler, opened } = await import('../../../src/livetvHandler')
          try { got = opened(await handler({ link: s.url, recipe: s.recipe, target: () => live.linkTarget(s.url) })) } catch { got = null }
        }
        if (gone || !got || !box.current) return
        const url = got.url
        v = document.createElement('video')
        v.muted = true
        v.setAttribute('playsinline', '')
        v.className = 'live-preview-video'
        v.addEventListener('playing', () => { if (!gone) setOn(true) })
        box.current.appendChild(v)
        const mse = typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E,mp4a.40.2"')
        if ((s.hls || got.hls) && mse) {
          const { default: Hls } = await import('hls.js')
          if (gone) return
          const h = new Hls({ maxBufferLength: 10, ...got.hls })
          h.loadSource(url)
          h.attachMedia(v)
          hls = h
        } else if (v.canPlayType('application/vnd.apple.mpegurl') || !s.hls) v.src = url
        else return
        v.play().catch(() => {})
      }, () => {})
    }, PREVIEW_AFTER_MS)
    return () => {
      gone = true
      clearTimeout(t)
      setOn(false)
      hls?.destroy()
      if (v) { v.pause(); v.removeAttribute('src'); v.load(); v.remove() }
    }
  }, [c.id, active])
  return <div ref={box} className={`live-preview${on ? ' on' : ''}`} />
}

/** "News · English · Germany": its kind, then up to two languages and two countries. */
export const metaOf = (c: LiveCard) => [c.kindName, ...c.languages.slice(0, 2).map(x => x.name), ...c.countries.slice(0, 2).map(x => x.name)].filter(Boolean).join(' · ')

/** A soft glow of a channel's colour: from 30% across, 20% down, [radius] rem. */
export function glow(hue: number, alpha: number, radius: number, x = '30%', y = '20%') {
  return `radial-gradient(circle ${radius}rem at ${x} ${y}, ${colour(hue, alpha)}, rgba(0, 0, 0, 0))`
}
/** A channel's own colour (hue, saturation 0.62, value 0.95), [alpha] of 255. */
export const colour = (hue: number, alpha: number) => `hsla(${hue}, 85%, 66%, ${(alpha / 255).toFixed(3)})`

/** An own item's corner badge and the line under its name. */
function badgeOf(c: LiveCard): { text: string; live: boolean } | null {
  if (c.state === 'live') return { text: '● LIVE', live: true }
  if (c.state === 'upcoming') return { text: 'SOON', live: false }
  if (c.state === '24/7') return { text: '24/7', live: false }
  return null
}
export function subOf(c: LiveCard): string | null {
  if (c.state === 'upcoming' && c.startsAt) return `Starts ${live.timeText(c.startsAt)}`
  const many = c.channels && c.channels.length > 1 ? `${c.channels.length} channels` : null
  return [c.about, many].filter(Boolean).join(' · ') || null
}

/** A channel tile: its logo (or its short name on its tint) on dark glass, the
 *  name under it; [sub]: the line under that ("about", or language · country in Browse all). */
export function ChannelTile({ c, load = true, sub, small }: { c: LiveCard; load?: boolean; sub?: string | null; small?: boolean }) {
  const [broken, setBroken] = useState(false)
  const badge = badgeOf(c)
  const line = sub !== undefined ? sub : subOf(c)
  const logo = load && c.logo && !broken
  return (
    <span className={`lc${small ? ' small' : ''}`}>
      <span className="lc-tile">
        <span className="lc-tint" style={{ background: glow(c.hue, c.logo ? 0x30 : 0x5c, small ? 100 : 140) }} />
        {logo ? <img className="lc-logo" src={c.logo!} alt="" onError={() => setBroken(true)} /> : <b className="lc-mono">{c.mono}</b>}
        {badge && <span className={`lc-badge${badge.live ? ' live' : ''}`}>{badge.text}</span>}
        {c.favourite && <span className="lc-star"><Icon name="star" size={9} /></span>}
        <span className="lc-sheen" />
      </span>
      <span className="lc-name">{c.name}</span>
      {line && <span className="lc-sub">{line}</span>}
    </span>
  )
}

/** A tile in the page's rows, by what it is. */
function LiveTile({ item, load }: { item: Item; load: boolean }) {
  if (item.type === 'channel') return <ChannelTile c={item.card} load={load} />
  if (item.type === 'every') return <EveryPanel count={item.count} logos={item.logos} load={load} />
  // A row's Browse all (its count), or a kind (its name on its tint, its logos dimmed).
  const logos = item.type === 'kind' ? item.logos : []
  return (
    <span className="lc">
      <span className="lc-tile">
        <span className="lc-tint" style={{ background: item.type === 'all' ? glow(220, 0x40, 150) : glow(live.hueOf(item.kind), logos.length ? 0x38 : 0x6e, 150) }} />
        {logos.length > 0 && load && (
          <span className="lc-mosaic">{Array.from({ length: 6 }, (_, n) => <img key={n} src={logos[n % logos.length]} alt="" />)}</span>
        )}
        {logos.length > 0 && <span className="lc-more-shade" />}
        <span className="lc-more">
          <b className={item.type === 'all' ? 'count' : 'name'}>{item.type === 'all' ? item.count.toLocaleString() : item.name}</b>
          <small>{item.type === 'all' ? (item.count === 1 ? 'channel' : 'channels') : channelsText(item.count)}</small>
        </span>
        <span className="lc-go"><Icon name="chevron" size={14} /></span>
        <span className="lc-sheen" />
      </span>
      {item.type === 'all' && <><span className="lc-name">Browse all</span><span className="lc-sub">{item.title}</span></>}
    </span>
  )
}

/** Search every channel: one wide glass panel; behind it two lines of logos drift
 *  slowly opposite ways (dim; brighter when focused); on it a search disc and what it is. */
function EveryPanel({ count, logos, load }: { count: number; logos: string[]; load: boolean }) {
  const PER_LINE = 12
  const line = (n: number) => Array.from({ length: 2 * PER_LINE }, (_, i) => logos[(i % PER_LINE + n * 7) % logos.length])
  return (
    <span className="lc-every">
      {logos.length > 0 && load && (
        <span className="every-wall">
          {[0, 1].map(n => (
            <span key={n} className={`every-line ${n ? 'right' : 'left'}`}>
              {line(n).map((src, i) => <span key={i} className="every-logo"><img src={src} alt="" /></span>)}
            </span>
          ))}
        </span>
      )}
      <span className="every-shade" />
      <span className="every-body">
        <span className="every-disc"><Icon name="search" size={24} /></span>
        <span className="every-text">
          <small>Every channel</small>
          <b>Search {channelsText(count)}</b>
          <span>By name, or look through every kind</span>
        </span>
      </span>
      <span className="lc-sheen" />
    </span>
  )
}

/** The long-press menu: add it to My channels, or take it out. */
export function MyChannelsSheet({ card, onToggle, onClose }: { card: LiveCard; onToggle: () => void; onClose: () => void }) {
  return (
    <Sheet title={card.name} subtitle={card.about || metaOf(card) || undefined} onClose={onClose}
      choices={[card.favourite ? { icon: 'act_remove', label: 'Remove from My channels', run: onToggle } : { icon: 'star', label: 'Add to My channels', run: onToggle }]} />
  )
}

/** The empty page's keys: Left from its first tile opens the side panel. */
function EmptyKeys({ onLeft, active }: { onLeft: () => void; active: boolean }) {
  useKeys(key => {
    const a = document.activeElement as HTMLElement | null
    if (key === 'left' && (!a || a === document.body || a.hasAttribute('data-first'))) { onLeft(); return true }
  }, active)
  useEffect(() => { const t = setTimeout(() => focusEl(document.querySelector<HTMLElement>('.live-empty [data-autofocus]')), 0); return () => clearTimeout(t) }, [])
  return null
}

