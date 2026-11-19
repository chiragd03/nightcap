// Licences and credits (from Settings), as the Android TV's: where the titles, the weather and the
// episodes come from; below, the parts the app is made with, and the licence of the one chosen.

import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import Icon from '../components/Icon'
import { SOURCE_NOTE, SOURCE_URL, TMDB_NOTICE, WEB_PARTS, tmdbLogo, type Part } from '../licences'
import './Licences.css'

export default function Licences() {
  const [part, setPart] = useState<Part>(WEB_PARTS[0])
  const [text, setText] = useState('')
  useEffect(() => {
    let live = true
    setText('')
    part.text().then(t => { if (live) setText(t) }, () => {})
    return () => { live = false }
  }, [part])

  return (
    <div className="lic">
      <div className="lic-top">
        <Link className="lic-back" to="/settings" aria-label="Back to Settings"><Icon name="chevron" size={16} /></Link>
        <span className="eyebrow">Licences and credits</span>
      </div>
      <div className="lic-credits">
        <img src={tmdbLogo} alt="The Movie Database (TMDB)" />
        <div>
          <p className="lic-notice">{TMDB_NOTICE}</p>
          <p className="lic-data">
            <a href="https://open-meteo.com" target="_blank" rel="noopener noreferrer">Weather data by Open-Meteo.com</a>
            <span aria-hidden>  ·  </span>
            <a href="https://www.tvmaze.com" target="_blank" rel="noopener noreferrer">Episode data from TVmaze</a>
          </p>
          <p className="lic-data"><a href={SOURCE_URL} target="_blank" rel="noopener noreferrer">{SOURCE_NOTE}</a></p>
        </div>
      </div>
      <div className="lic-main">
        <div className="lic-parts" role="listbox" aria-label="Parts">
          {WEB_PARTS.map(p => (
            <button key={p.name} role="option" aria-selected={p === part} className={`lic-part${p === part ? ' on' : ''}`} onClick={() => setPart(p)}>
              <span>{p.name}</span><small>{p.licence}</small>
            </button>
          ))}
        </div>
        <pre className="lic-text" tabIndex={0} aria-label={`${part.name} licence`}>{text}</pre>
      </div>
    </div>
  )
}
