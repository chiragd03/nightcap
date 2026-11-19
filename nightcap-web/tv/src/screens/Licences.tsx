// Licences and credits, as the Android TV's: where the titles, the weather and the episodes come
// from; below, the parts the app is made with on the left, and the licence of the one focused on
// the right (Right goes into it, Up and Down scroll it, Left comes back).

import { useEffect, useRef, useState } from 'react'
import { DATA_CREDITS, SOURCE_NOTE, TMDB_NOTICE, TV_PARTS, tmdbLogo, type Part } from '../../../src/licences'
import { focus as focusEl } from '../focus'
import { useKeys } from '../nav'
import './Licences.css'

export default function Licences() {
  const [text, setText] = useState('')
  const box = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const last = useRef<HTMLElement | null>(null)
  const shown = useRef<Part | null>(null)

  const show = (part: Part) => {
    shown.current = part
    if (box.current) box.current.scrollTop = 0
    part.text().then(t => { if (shown.current === part) setText(t) }, () => { if (shown.current === part) setText('') })
  }
  useEffect(() => { focusEl(list.current?.querySelector<HTMLElement>('[data-f]')) }, [])

  useKeys(key => {
    if (document.activeElement !== box.current) return false
    // (In the licence: Up and Down scroll it, Left goes back to its part.)
    if (key === 'up' || key === 'down') {
      const el = box.current!
      el.scrollTop += (key === 'down' ? 1 : -1) * el.clientHeight * 0.6
      return true
    }
    if (key === 'left') { focusEl(last.current); return true }
    return false
  })

  return (
    <div className="lic">
      <span className="eyebrow corner-eyebrow">Licences and credits</span>
      <div className="lic-body">
        <div className="lic-credits">
          <img src={tmdbLogo} alt="The Movie Database (TMDB)" />
          <div>
            <p className="lic-notice">{TMDB_NOTICE}</p>
            <p className="lic-data">{DATA_CREDITS}</p>
            <p className="lic-data">{SOURCE_NOTE}</p>
          </div>
        </div>
        <div className="lic-main">
          <div ref={list} className="lic-parts">
            {TV_PARTS.map(part => (
              <button key={part.name} className="lic-part" data-f=""
                onFocus={e => { last.current = e.currentTarget; show(part) }} onClick={() => focusEl(box.current)}>
                {part.name}  ·  {part.licence}
              </button>
            ))}
          </div>
          <div ref={box} className="lic-text" data-f="" tabIndex={-1}>{text}</div>
        </div>
      </div>
    </div>
  )
}
