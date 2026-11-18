import { useEffect, useRef, useState, type ReactNode } from 'react'
import { focus, focusFirst } from '../focus'
import { useKeys } from '../nav'
import './Panel.css'
import * as keyboard from '../keyboard'

// Connect's glass panel: a heading, a line, a field (or the join code's
// eight boxes), the action and Cancel, and a status line. It sits high so the TV's keyboard opens
// below it. Down from the field goes to the action; Up from the buttons back to the field; Back is
// Cancel. The keyboard's Go/Done runs the action.

export default function Panel({ heading, text, go, status, waiting, busy, code, placeholder, initial = '', onGo, onCancel }: {
  heading: string; text: string; go: string; status?: string; busy?: boolean
  /** The status is something under way: it breathes. */
  waiting?: boolean
  /** The join code's eight boxes instead of a plain field. */
  code?: boolean
  placeholder?: string; initial?: string
  onGo: (value: string) => void; onCancel: () => void
}) {
  const [value, setValue] = useState(code ? initial.toUpperCase().slice(0, 8) : initial)
  const [typing, setTyping] = useState(true)
  const field = useRef<HTMLInputElement>(null)
  const goButton = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    focus(field.current)
    // (All of it selected, to type over; the code's caret at its end.)
    if (!code) field.current?.select()
  }, [code])

  useKeys((key, e) => {
    if (key === 'back') { onCancel(); return true }
    const inField = document.activeElement === field.current
    // Back that only closed the TV's keyboard (webOS takes focus off the field): the arrows find
    // the panel again, Up the field and the rest the action.
    if (key === 'up' || key === 'down' || key === 'left' || key === 'right') {
      const a = document.activeElement
      if (!a || !a.closest('.panel')) { focus(key === 'up' ? field.current : goButton.current); return true }
    }
    if (key === 'down' && inField) { focus(goButton.current); return true }
    if (key === 'up' && !inField) { focus(field.current); return true }
    if (key === 'ok' && inField && keyboard.typing()) { e.preventDefault(); onGo(value); return true }
  })

  const boxes: ReactNode[] = []
  if (code) {
    for (let i = 0; i < 8; i++) {
      const next = typing && (i === value.length || (value.length === 8 && i === 7))
      boxes.push(<span key={i} className={`code-box${next ? ' next' : ''}${i === 4 ? ' half' : ''}`}>{value[i] ?? ''}</span>)
    }
  }

  return (
    <div className="panel-scrim">
      <div className="panel" data-scope="" role="dialog" aria-label={heading}>
        <b className="panel-heading">{heading}</b>
        <p className="panel-text">{text}</p>
        <div className={code ? 'code' : 'field-wrap'}>
          {code && boxes}
          <input ref={field} className={code ? 'code-input' : 'field'} data-f="" value={value} placeholder={code ? '' : placeholder}
            spellCheck={false} autoComplete="off" autoCapitalize={code ? 'characters' : 'off'} autoCorrect="off"
            maxLength={code ? 8 : 300} aria-label={heading}
            onFocus={() => setTyping(true)} onBlur={() => setTyping(false)}
            onChange={e => setValue(code ? e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) : e.target.value)} />
        </div>
        <div className="panel-buttons">
          <button ref={goButton} className="pill go" data-f="" disabled={busy} onClick={() => onGo(value)}>{go}</button>
          <button className="pill" data-f="" onClick={onCancel}>Cancel</button>
        </div>
        {status && <p className={`panel-status${waiting ? ' waiting' : ''}`} role="status">{status}</p>}
      </div>
    </div>
  )
}

/** Puts focus back on the first thing in a scope once a panel has gone (used by screens). */
export const refocus = (el: Element | null) => setTimeout(() => focusFirst(el), 0)
