import { useNavigate } from 'react-router-dom'
import Icon from './Icon'
import './BackButton.css'

/** Back to the screen before (Home when this page was opened directly): a round glass button. */
export default function BackButton({ className = '' }: { className?: string }) {
  const navigate = useNavigate()
  // React Router numbers this tab's history; 0 means nothing of ours to go back to.
  const back = () => ((window.history.state?.idx ?? 0) > 0 ? navigate(-1) : navigate('/'))
  return (
    <button className={`back-button ${className}`} aria-label="Back" title="Back" onClick={back}>
      <Icon name="chevron" size={22} />
    </button>
  )
}
