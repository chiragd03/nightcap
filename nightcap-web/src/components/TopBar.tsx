import { useEffect, useState } from 'react'
import { useScreenLoading } from '../lazy'
import './Waiting.css'

/** A thin line along the top while a screen's code is on its way, after 300 ms (a quick one shows nothing). */
export default function TopBar() {
  const loading = useScreenLoading()
  const [late, setLate] = useState(0)
  useEffect(() => {
    if (!loading) return
    const t = setTimeout(() => setLate(n => n + 1), 300)
    return () => { clearTimeout(t); setLate(0) }
  }, [loading])
  return loading && late ? <div className="top-bar" role="progressbar" aria-label="Loading" /> : null
}
