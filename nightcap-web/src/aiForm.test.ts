import { describe, expect, it } from 'vitest'
import { keyLooksRight, priceFields, readPrice, removeBody, saveBody, testBody } from './aiForm'

const saved = { provider: 'openrouter', providerName: 'OpenRouter', key: '••••abcd', model: 'a/model', baseUrl: null, price: [1, 2] as [number, number] }

describe('readPrice', () => {
  it('both empty: no price', () => expect(readPrice('', ' ', false)).toEqual({ kind: 'none' }))
  it('Free wins', () => expect(readPrice('3', '4', true)).toEqual({ kind: 'price', price: [0, 0] }))
  it('two numbers', () => expect(readPrice('0.25', '2', false)).toEqual({ kind: 'price', price: [0.25, 2] }))
  it('one missing, text, negative or too big: not a price', () => {
    for (const [a, b] of [['1', ''], ['x', '2'], ['-1', '2'], ['1', '5000'], ['0x10', '1'], ['1e2', '1']]) expect(readPrice(a, b, false)).toEqual({ kind: 'bad' })
  })
})

describe('priceFields', () => {
  it("the saved model: its saved price", () => expect(priceFields('a/model', saved)).toEqual({ input: '1', output: '2', free: false }))
  it('another model: empty (never the saved one carried over)', () => expect(priceFields('b/model', saved)).toEqual({ input: '', output: '', free: false }))
  it('a free saved model', () => expect(priceFields('a/model', { ...saved, price: [0, 0] })).toEqual({ input: '0', output: '0', free: true }))
})

describe('saveBody', () => {
  const f = { provider: 'other', key: ' test-key ', baseUrl: ' http://ai.home/v1 ', needsBaseUrl: true, model: 'm', price: null }
  it('a new AI: its key and address', () => expect(saveBody({ ...f, changing: false })).toEqual({ provider: 'other', key: 'test-key', model: 'm', baseUrl: 'http://ai.home/v1', price: null }))
  it('no address for a provider without one', () => expect(saveBody({ ...f, changing: false, provider: 'openai', needsBaseUrl: false }).baseUrl).toBeNull())
  it('changing the model: the saved key (null), no address', () => expect(saveBody({ ...f, changing: true, price: [1, 2] })).toEqual({ provider: 'other', key: null, model: 'm', price: [1, 2] }))
})

describe('testBody', () => {
  const f = { provider: 'openai', key: 'k'.repeat(30), baseUrl: '', needsBaseUrl: false, model: 'gpt-x' }
  it('changing the model: no key (the server uses the saved one)', () => expect(testBody({ ...f, changing: true })).toEqual({ what: 'ai', provider: 'openai', model: 'gpt-x' }))
  it('a new AI: the typed key', () => expect(testBody({ ...f, changing: false }).key).toBe('k'.repeat(30)))
  it('a typed model name is trimmed', () => expect(testBody({ ...f, changing: true, model: ' my-model ' }).model).toBe('my-model'))
})

describe('removeBody', () => {
  it('the saved provider, no key, no model', () => expect(removeBody(saved, [])).toEqual({ provider: 'openrouter', key: null }))
  it('a key saved before its provider was kept: any provider', () => expect(removeBody({ ...saved, provider: null }, [{ id: 'anthropic', name: '', needsBaseUrl: false, needsModel: true, defaultModel: null }])).toEqual({ provider: 'anthropic', key: null }))
})

describe('keyLooksRight', () => {
  it("other: any key without spaces (as the server's check)", () => {
    expect(keyLooksRight('other', 'x')).toBe(true)
    expect(keyLooksRight('other', 'a b')).toBe(false)
  })
  it('others: 20 to 300 characters, no spaces', () => {
    expect(keyLooksRight('openai', 'short')).toBe(false)
    expect(keyLooksRight('openai', 'a'.repeat(25))).toBe(true)
    expect(keyLooksRight('openai', 'a'.repeat(12) + ' ' + 'a'.repeat(12))).toBe(false)
  })
})
