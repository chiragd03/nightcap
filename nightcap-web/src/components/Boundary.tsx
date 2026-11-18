import { Component, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { isChunkError, playing, reloadForChunks } from '../appUpdate'
import Problem from './Problem'

type Props = { path: string; children: ReactNode }
type State = { error: unknown; path: string }

/** Catches a screen that fails to draw (or whose code can't be fetched), and shows what went wrong
 * instead of a blank page. Going to another page clears it. */
class Catch extends Component<Props, State> {
  state: State = { error: undefined, path: this.props.path }

  static getDerivedStateFromError(error: unknown) {
    return { error }
  }

  // Another page: the error was this one's.
  static getDerivedStateFromProps(props: Props, state: State) {
    return props.path === state.path ? null : { error: undefined, path: props.path }
  }

  componentDidCatch(error: unknown) {
    console.error(error)
    // A screen's code a deploy took away: the new version is loaded (once per build).
    if (isChunkError(error) && navigator.onLine) reloadForChunks()
    else if (isChunkError(error)) addEventListener('online', this.online)
  }

  componentWillUnmount() {
    removeEventListener('online', this.online)
  }

  /** The connection back: the screen's code can be fetched now (a reload, as a failed fetch is kept). */
  online = () => {
    if (isChunkError(this.state.error) && !playing()) location.reload()
  }

  render() {
    const { error } = this.state
    if (error === undefined) return this.props.children
    // (A screen's code that couldn't be fetched: tried again by itself, the connection back, the tab
    // shown again, or every 15 s while in view: the server may be starting.)
    return isChunkError(error)
      ? <Problem words={navigator.onLine ? 'Something went wrong. Try again in a moment.' : "Couldn't reach the server. Try again."}
          retry={() => { if (!playing()) location.reload() }} back autoRetry retryEvery={15_000} />
      : <Problem words="Something went wrong. Try again in a moment." retry={() => location.reload()} back />
  }
}

export default function Boundary({ children }: { children: ReactNode }) {
  return <Catch path={useLocation().pathname}>{children}</Catch>
}
