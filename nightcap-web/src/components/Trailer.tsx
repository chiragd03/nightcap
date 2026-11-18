import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import Icon from './Icon'
import './Trailer.css'

// A title's trailer (TMDB's, a YouTube video) over the page, in YouTube's own player with its own
// controls: sound, full screen and the rest work as people know them. Esc, ✕ or a click beside
// the video closes it, and the page behind keeps its place.
//
// The frame says where it's embedded from: the server sends Referrer-Policy: no-referrer, and
// YouTube's player refuses to play without a referrer (its error 153).

type Props = { id: string; name: string; onClose: () => void }

export default function Trailer({ id, name, onClose }: Props) {
  const close = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    // Focus to ✕ while open, and back to what opened it after.
    const was = document.activeElement as HTMLElement | null
    close.current?.focus({ preventScroll: true })
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey); was?.focus?.({ preventScroll: true }) }
  }, [onClose])

  const vars = new URLSearchParams({ autoplay: '1', rel: '0', playsinline: '1', modestbranding: '1', iv_load_policy: '3' })
  return createPortal(
    <div className="tr-scrim" onClick={onClose} role="dialog" aria-modal="true" aria-label={`${name} trailer`}>
      <div className="tr" onClick={e => e.stopPropagation()}>
        <div className="tr-head">
          <div className="tr-title"><span className="eyebrow">Trailer</span><span className="tr-name">{name}</span></div>
          <button ref={close} className="tr-close" onClick={onClose} aria-label="Close trailer" title="Close (Esc)">
            <Icon name="act_close" size={22} />
          </button>
        </div>
        <div className="tr-video">
          <iframe
            src={`https://www.youtube.com/embed/${encodeURIComponent(id)}?${vars}`}
            title={`${name} trailer`}
            allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
          />
        </div>
      </div>
    </div>,
    document.body,
  )
}
