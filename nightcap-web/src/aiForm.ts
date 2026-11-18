// The AI form's rules (Settings → Sources and keys → AI), kept apart so they're tested: what a typed
// price means, and what's sent to the server.

import type { AiSave, Sources } from './api'

export type Price = [number, number]
/** What the price fields say: no price (both empty), a price, or something that isn't one. */
export type TypedPrice = { kind: 'none' } | { kind: 'price'; price: Price } | { kind: 'bad' }

const PRICE_MAX = 1000

/** The Advanced fields read: [free] wins; both empty is no price; else two numbers 0 to 1000. */
export function readPrice(input: string, output: string, free: boolean): TypedPrice {
  if (free) return { kind: 'price', price: [0, 0] }
  const a = input.trim(), b = output.trim()
  if (!a && !b) return { kind: 'none' }
  const x = Number(a), y = Number(b)
  if (!/^\d+(\.\d+)?$/.test(a) || !/^\d+(\.\d+)?$/.test(b) || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > PRICE_MAX || y > PRICE_MAX) return { kind: 'bad' }
  return { kind: 'price', price: [x, y] }
}

/** The price fields for [model]: the saved price when it's the saved model, else empty. */
export function priceFields(model: string, saved?: Sources['ai'] | null) {
  const p = saved?.model && model === saved.model ? saved.price : null
  return { input: p ? String(p[0]) : '', output: p ? String(p[1]) : '', free: !!p && p[0] === 0 && p[1] === 0 }
}

/** What Save sends: a new AI (its key, and its address for "other"), or a new model for the saved key. */
export function saveBody(f: { changing: boolean; provider: string; key: string; baseUrl: string; needsBaseUrl: boolean; model: string; price: Price | null }): AiSave {
  return f.changing
    ? { provider: f.provider, key: null, model: f.model.trim(), price: f.price }
    : { provider: f.provider, key: f.key.trim(), model: f.model.trim(), baseUrl: f.needsBaseUrl ? f.baseUrl.trim() : null, price: f.price }
}

/** What Test sends: the typed key (and address), or, changing the model, the saved key (no key). */
export function testBody(f: { changing: boolean; provider: string; key: string; baseUrl: string; needsBaseUrl: boolean; model: string }) {
  return f.changing
    ? { what: 'ai', provider: f.provider, model: f.model.trim() }
    : { what: 'ai', provider: f.provider, key: f.key.trim(), model: f.model.trim(), baseUrl: f.needsBaseUrl ? f.baseUrl.trim() : null }
}

/** What removing the AI sends: no key and no model (any provider will do; the saved one if known). */
export function removeBody(ai: NonNullable<Sources['ai']>, providers: Sources['providers']): AiSave {
  return { provider: ai.provider ?? providers[0]?.id ?? 'anthropic', key: null }
}

/** Whether a key looks like one the server would take (so the models list isn't asked with one it refuses). */
export function keyLooksRight(provider: string, key: string) {
  const k = key.trim()
  if (/\s/.test(k)) return false
  return provider === 'other' ? k.length >= 1 : k.length >= 20 && k.length <= 300
}
