// Asking the server where a playback link leads (X-Where: 2), shared by the web app and the Samsung/LG
// app: both are served by the Nightcap server, so the ask is a plain same-origin fetch, with no device
// headers (the link's token is the right to it).

/** A playback link (/s/…) by its path, on the page's own address: the server sends no CORS headers, and
 * X-Where forces a preflight, so a link asked at another host would fail outright. */
export const linkPath = (link: string) => { const u = new URL(link, location.origin); return u.pathname + u.search }

/** What the server said about a playback link, asked with X-Where: 2 (see the player's session.ts):
 * its status, Retry-After (seconds), its headers, and where it leads when it answered 200. */
export type LinkAnswer = { status: number; retryAfter: number | null; header: (name: string) => string | null; where?: { url: string; direct: boolean } }

/** Asks where [link] leads now. Throws AbortError when [signal] fires, TypeError with no connection. */
export async function askLink(link: string, signal: AbortSignal): Promise<LinkAnswer> {
  const r = await fetch(linkPath(link), { headers: { 'X-Where': '2' }, cache: 'no-store', signal })
  const after = Number(r.headers.get('Retry-After'))
  const where = r.status === 200 ? await r.json().catch(() => undefined) as { url: string; direct: boolean } | undefined : undefined
  return { status: r.status, retryAfter: Number.isFinite(after) && after > 0 ? after : null, header: n => r.headers.get(n), where }
}
