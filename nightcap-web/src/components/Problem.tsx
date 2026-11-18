import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { WORDS } from '../errors'
import './Waiting.css'

/** Something went wrong: what, in plain words, with Try again (when trying again can help) and Back
 * (when there's somewhere to go). [autoRetry]: tried again by itself when the connection comes back
 * and when the tab is shown again (never on a timer while nobody's looking). */
export default function Problem({ words, retry, back, autoRetry, retryEvery }: { words: string; retry?: () => void; back?: boolean; autoRetry?: boolean; retryEvery?: number }) {
  const navigate = useNavigate()
  useEffect(() => {
    if (!retry || !autoRetry) return
    const again = () => { if (document.visibilityState === 'visible' && navigator.onLine) retry() }
    addEventListener('online', again)
    document.addEventListener('visibilitychange', again)
    // (A server still starting: tried again every few seconds while the tab is in view, so the page
    // comes by itself once it's up.)
    const every = retryEvery ?? (words === WORDS.starting ? 5000 : undefined)
    const timer = every ? setInterval(again, every) : undefined
    return () => { removeEventListener('online', again); document.removeEventListener('visibilitychange', again); clearInterval(timer) }
  }, [retry, autoRetry, words, retryEvery])
  const goBack = () => ((window.history.state?.idx ?? 0) > 0 ? navigate(-1) : navigate('/'))
  return (
    <div className="problem" role="alert">
      <p>{words}</p>
      {(retry || back) && (
        <div className="problem-actions">
          {retry && <button className="btn primary" onClick={retry}>Try again</button>}
          {back && <button className="btn" onClick={goBack}>Back</button>}
        </div>
      )}
    </div>
  )
}
