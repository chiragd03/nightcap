import './Waiting.css'
import { useLocation } from 'react-router-dom'
import { playerOpen, useNewVersion } from '../appUpdate'

/** "A new version is ready", once a deploy's new version has taken over from the one this page runs. */
export default function NewVersion() {
  const ready = useNewVersion()
  useLocation() // (drawn again on every page: not over a player)
  if (!ready || playerOpen()) return null
  return (
    <div className="new-version glass" role="status">
      A new version is ready
      <button className="btn primary" onClick={() => location.reload()}>Reload</button>
    </div>
  )
}
