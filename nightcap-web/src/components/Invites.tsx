import { useCallback, useEffect, useState } from 'react'
import * as api from '../api'
import Icon from './Icon'
import { AddRow, Back, Detail, Pill, Row } from './PanelParts'
import './Invites.css'
import { useLimitsReady } from '../limits'
import { errorWords } from '../errors'

// A household's invites, in a side panel: the server owner's (Owner) and its admin's (Settings),
// the same but for who's asking ([maker]). Each invite lets one TV or browser join, once, within 24
// hours, and is named for who it's for: the device that joins with it takes that name. A new one's
// code shows here once (the server keeps only a hash); after that it's a row to cancel, then a row
// saying which device joined with it, which the admin can take off the list (one, or all of them); they
// also go by themselves after 7 days.

type Saver = (job: Promise<unknown>, done: string) => Promise<void>

export default function Invites({ maker, fresh: first, onMade, save, parent }: {
  maker: api.InviteMaker
  /** Where the list itself goes back to (the owner's household page), if anywhere: one back bar,
   * titled Invites, whichever page of the invites is showing. */
  parent?: { name: string; onBack: () => void }
  /** One made just now elsewhere (a new household's first invite), to show its code. */
  fresh?: api.NewInvite
  onMade?: (made: api.NewInvite) => void
  save: Saver
}) {
  const [list, setList] = useState<api.Invite[]>()
  const [fresh, setFresh] = useState(first)
  const [page, setPage] = useState<'list' | 'new' | string>('list')
  // (The list couldn't be had: said, with Try again; not an empty list.)
  const [failed, setFailed] = useState<unknown>()
  const reload = useCallback(() => maker.list().then(l => { setList(l); setFailed(undefined) }, setFailed), [maker])
  useEffect(() => { reload() }, [reload])

  const make = (label: string | null) => {
    const job = maker.make(label)
    job.then(made => { setFresh(made); onMade?.(made); setPage('list') }, () => {})
    save(job, label ? `Invite made for ${label}` : 'Invite made').catch(() => {}).then(reload)
  }
  const cancel = (i: api.Invite) => {
    const job = maker.cancel(i.id)
    job.then(() => { if (fresh?.id === i.id) setFresh(undefined); setPage('list') }, () => {})
    save(job, 'Invite cancelled').catch(() => {}).then(reload)
  }

  const remove = (i: api.Invite) => {
    if (!maker.remove) return
    const job = maker.remove(i.id)
    job.then(() => setPage('list'), () => {})
    save(job, 'Invite removed').catch(() => {}).then(reload)
  }
  const clear = () => {
    if (!maker.clear) return
    const job = maker.clear()
    save(job, 'Finished invites cleared').catch(() => {}).then(reload)
  }

  const back = <Back onClick={() => setPage('list')}>Invites</Back>
  const top = parent && <Back onClick={parent.onBack} title="Invites">{parent.name}</Back>
  if (page === 'new') return <>{back}<NewInvite onMake={make} /></>
  const open = list?.find(i => i.id === page)
  if (open) {
    return (
      <>
        {back}
        <Detail mark={<InviteMark invite={open} big />} name={nameOf(open)} lines={linesOf(open)} />
        {open.state === 'open' && <Pill icon="act_remove" danger sub="Its code stops working at once" onClick={() => cancel(open)}>Cancel this invite</Pill>}
        {open.state !== 'open' && maker.remove && <Pill icon="act_remove" sub="The device that joined with it stays" onClick={() => remove(open)}>Remove from the list</Pill>}
      </>
    )
  }

  const waiting = list?.filter(i => i.state === 'open') ?? []
  const earlier = list?.filter(i => i.state !== 'open') ?? []
  return (
    <>
      {top}
      {fresh && waiting.some(i => i.id === fresh.id) && <Fresh invite={fresh} onDone={() => setFresh(undefined)} />}
      <AddRow onClick={() => setPage('new')}>Invite a device</AddRow>
      {!list && !failed && <p className="pn-note">Loading…</p>}
      {!list && !!failed && <><p className="pn-note">{errorWords(failed)}</p><button className="btn" onClick={() => { setFailed(undefined); reload() }}>Try again</button></>}
      {waiting.length > 0 && <h4 className="pn-sub">Waiting to be used</h4>}
      {waiting.map(i => <Row key={i.id} mark={<InviteMark invite={i} />} name={nameOf(i)} sub={`Works ${timeLeft(i.expiresAt)} more`} onClick={() => setPage(i.id)} />)}
      {earlier.length > 0 && <h4 className="pn-sub">Earlier</h4>}
      {earlier.map(i => <Row key={i.id} mark={<InviteMark invite={i} />} name={nameOf(i)} sub={linesOf(i)[0]} onClick={() => setPage(i.id)} />)}
      {earlier.length > 0 && maker.clear && (
        <>
          <Pill icon="act_remove" sub="The devices that joined stay" onClick={clear}>Clear these</Pill>
          <p className="pn-note">Used and expired invites also go by themselves after 7 days.</p>
        </>
      )}
    </>
  )
}

function NewInvite({ onMake }: { onMake: (label: string | null) => void }) {
  const lim = useLimitsReady()
  const [label, setLabel] = useState('')
  return (
    <form className="pn-form" onSubmit={e => { e.preventDefault(); onMake(label.trim() || null) }}>
      <h4 className="pn-sub">Who's it for?</h4>
      <input className="pn-input" value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. Bedroom TV" maxLength={lim.names.inviteLabel} autoFocus aria-label="Who the invite is for" />
      <p className="pn-note">The TV or browser that joins with it takes this name, so you can tell it apart in Devices. It works for one device, once, within 24 hours.</p>
      <div className="pn-buttons"><button className="btn primary">Make the invite</button></div>
    </form>
  )
}

/** A just-made invite (or a device's own sign-in code, [tv]: for a TV): the code big, and its link and
 * code to copy. Shown this once. */
export function Fresh({ invite, onDone, tv }: { invite: api.NewInvite; onDone: () => void; tv?: boolean }) {
  const [copied, setCopied] = useState<'link' | 'code'>()
  const copy = (what: 'link' | 'code', text: string) => navigator.clipboard?.writeText(text).then(() => { setCopied(what); setTimeout(() => setCopied(undefined), 1500) })
  return (
    <div className="inv-fresh">
      <span className="inv-for">{invite.for ? `Sign-in code for ${invite.for.name}` : invite.label ? `For ${invite.label}` : 'New invite'}</span>
      <span className="inv-code">{invite.code.slice(0, 4)} {invite.code.slice(4)}</span>
      <span className="inv-line">{invite.for
        ? `Enter it on ${invite.for.name} ${tv ? '(type the code on the TV)' : '(open the link in that browser)'} to sign it back in as itself. Once, within ${timeLeft(invite.expiresAt)}. Copy it now: it isn't shown again.`
        : `One device, once, within ${timeLeft(invite.expiresAt)}. A browser opens the link; a TV types the code. Copy it now: it isn't shown again.`}</span>
      <div className="inv-copy">
        {!tv && (
          <button type="button" className="inv-btn" onClick={() => copy('link', api.inviteLink(invite.code))}>
            <Icon name={copied === 'link' ? 'check' : 'act_watched'} size={15} /> {copied === 'link' ? 'Link copied' : 'Copy the link'}
          </button>
        )}
        <button type="button" className="inv-btn" onClick={() => copy('code', invite.code)}>
          <Icon name={copied === 'code' ? 'check' : 'act_watched'} size={15} /> {copied === 'code' ? 'Code copied' : 'Copy the code'}
        </button>
        <button type="button" className="inv-btn quiet" onClick={onDone}>Done</button>
      </div>
    </div>
  )
}

const nameOf = (i: api.Invite) => i.for ? `For ${i.for.name}` : i.label ?? (i.state === 'used' && i.device ? i.device.name : 'Unnamed invite')

function linesOf(i: api.Invite) {
  const by = i.madeBy === 'admin' ? "the household's admin" : 'the server owner'
  if (i.for) {
    // (A device's own sign-in code: it signs back in as itself.)
    if (i.state === 'used') return [`Signed back in ${ago(i.usedAt!)}`, 'Sign-in code']
    if (i.state === 'expired') return ['Expired without being used', 'Sign-in code']
    return [`Works ${timeLeft(i.expiresAt)} more, only on ${i.for.name}`, `Sign-in code, made ${ago(i.created)}`]
  }
  // ("Joined as …" only when the device has been renamed since: otherwise it's the invite's name.)
  const joined = !i.device ? `Used ${ago(i.usedAt!)}; that device has been removed since`
    : i.device.name === i.label ? `Joined ${ago(i.usedAt!)}` : `Joined as ${i.device.name} ${ago(i.usedAt!)}`
  if (i.state === 'used') return [joined, `Made by ${by}`]
  if (i.state === 'expired') return ['Expired without being used', `Made by ${by}`]
  return [`Works ${timeLeft(i.expiresAt)} more, for one device`, `Made by ${by} ${ago(i.created)}`]
}

function InviteMark({ invite, big }: { invite: api.Invite; big?: boolean }) {
  return (
    <span className={`mark inv-mark ${invite.state}${big ? ' big' : ''}`} aria-hidden>
      <Icon name={invite.state === 'used' ? 'check' : invite.state === 'expired' ? 'act_later' : 'add'} size={big ? 26 : 15} />
    </span>
  )
}

function timeLeft(iso: string) {
  const min = Math.max(1, Math.round((new Date(iso).getTime() - Date.now()) / 60_000))
  return min < 60 ? `${min} min` : `${Math.round(min / 60)} h`
}

function ago(iso: string) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 90) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} minutes ago`
  if (s < 86400) return `${Math.round(s / 3600)} hours ago`
  if (s < 2 * 86400) return 'yesterday'
  return `on ${new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`
}
