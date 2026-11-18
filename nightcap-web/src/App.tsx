import { Suspense } from 'react'
import { BrowserRouter, Route, Routes, useLocation } from 'react-router-dom'
import Boundary from './components/Boundary'
import NewVersion from './components/NewVersion'
import Problem from './components/Problem'
import Rail from './components/Rail'
import Scroll from './components/Scroll'
import TopBar from './components/TopBar'
import Waiting from './components/Waiting'
import Waking from './components/Waking'
import { lazyScreen } from './lazy'
import Home from './screens/Home'
import Invite from './screens/Invite'
import Profiles from './screens/Profiles'
import Search from './screens/Search'
import Setup from './screens/Setup'
import TitlePage from './screens/TitlePage'
import { SessionProvider, useSession } from './session'

// Screens fetched when first opened: the first page load carries only what Home needs.
const loadLive = () => import('./screens/LiveTv')
const Player = lazyScreen(() => import('./screens/Player'), m => m.default)
const Settings = lazyScreen(() => import('./screens/Settings'), m => m.default)
const Owner = lazyScreen(() => import('./screens/Owner'), m => m.default)
const Sent = lazyScreen(() => import('./screens/Sent'), m => m.default)
const LiveTv = lazyScreen(loadLive, m => m.default)
const LiveBrowse = lazyScreen(loadLive, m => m.LiveBrowse)
const LivePlayer = lazyScreen(loadLive, m => m.LivePlayer)

/** While a screen opened straight from its address (a reload, a link) is on its way. */
const screenWait = <Waiting after={300} />


// Nothing loads until the server knows whose request it is: this browser joins a household first
// (once), then who's watching.
function Gate() {
  const { joined, profileId } = useSession()
  // Pages that come before (or outside) a household: an invite, and the server's owner.
  const outside = (
    <Suspense fallback={screenWait}>
      <Routes>
        <Route path="/join" element={<Invite />} />
        <Route path="/server" element={<Owner />} />
      </Routes>
    </Suspense>
  )
  const path = useLocation().pathname
  if (/^\/(join|server)$/.test(path)) return outside
  if (!joined) return <Setup />
  if (!profileId) return <Profiles />
  return (
    <>
      <Rail />
      {/* Keyed by profile, so switching profile loads everything afresh. */}
      <main key={profileId}>
        <Boundary>
          <Suspense fallback={screenWait}>
            <Routes>
              <Route path="/" element={<Home key="home" />} />
              <Route path="/shows" element={<Home key="tv" page="tv" />} />
              <Route path="/movies" element={<Home key="movie" page="movie" />} />
              <Route path="/profiles" element={<Profiles />} />
              <Route path="/search" element={<Search />} />
              <Route path="/sent" element={<Sent />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/settings/profiles" element={<Settings />} />
              <Route path="/title/:type/:id" element={<TitlePage kind="title" />} />
              <Route path="/person/:id" element={<TitlePage kind="person" />} />
              <Route path="/browse/:key" element={<TitlePage kind="browse" />} />
              <Route path="/watch/:type/:vid" element={<Player />} />
              <Route path="/live" element={<LiveTv />} />
              <Route path="/live/browse" element={<LiveBrowse />} />
              <Route path="/live/watch/:channel" element={<LivePlayer />} />
              <Route path="*" element={<Problem words="This page isn't available right now." back />} />
            </Routes>
          </Suspense>
        </Boundary>
      </main>
    </>
  )
}

export default function App() {
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <Boundary>
        <SessionProvider>
          <Gate />
        </SessionProvider>
      </Boundary>
      <Scroll />
      <Waking />
      <TopBar />
      <NewVersion />
    </BrowserRouter>
  )
}
