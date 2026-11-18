// The hook for opening a Live TV stream that comes with a recipe. A handler gets the stream's playback
// link, its recipe and where the link leads, and gives back an address the player can play (an HLS
// playlist), optionally with hls.js settings of its own (`hls`: its loaders, `xhrSetup`…) so its logic
// runs on every request for that stream; or null if it can't open it, and the player moves on to the
// next stream.

import type { HlsConfig } from 'hls.js'
import type { LiveRecipe } from './api'
import { handler as mine } from '@nightcap/private-handler'

export type StreamContext = {
  /** The stream's playback link (this device's, on the server). */
  link: string
  /** Its recipe, as the list describes it. */
  recipe: LiveRecipe
  /** Where the playback link leads (the stream's own address, as the list has it). */
  target: () => Promise<string>
}

/** What a handler gives back: an address to play, or one with hls.js settings of its own for it. */
export type Opened = { url: string; hls?: Partial<HlsConfig> }

/** How to play a stream with a recipe, or null if this handler can't open it. */
export type StreamHandler = (ctx: StreamContext) => Promise<string | Opened | null>

/** A handler's answer as an address and (maybe) settings; null for none. */
export const opened = (r: string | Opened | null | undefined): Opened | null => (!r ? null : typeof r === 'string' ? { url: r } : r.url ? r : null)

// The optional handler (privateHandler.ts), else none: the items that need one are skipped.
export const handler: StreamHandler = mine ?? (async () => null)
