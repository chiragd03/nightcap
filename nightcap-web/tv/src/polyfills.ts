// What 2020 TVs' browser engines (Chromium 68/69) lack and the app or React may use. Syntax is
// lowered at build time (vite.tv.config.ts); these are the few library functions.

const g = (typeof window !== 'undefined' ? window : self) as unknown as Record<string, unknown>
if (!('globalThis' in g)) g.globalThis = g
if (typeof queueMicrotask !== 'function') {
  g.queueMicrotask = (cb: () => void) => { Promise.resolve().then(cb) }
}
const P = Promise as unknown as Record<string, unknown>
if (!P.allSettled) {
  P.allSettled = (items: Iterable<unknown>) => Promise.all(Array.from(items, p => Promise.resolve(p).then(
    value => ({ status: 'fulfilled', value }), reason => ({ status: 'rejected', reason }))))
}
// Array flat and flatMap: Chrome 69 (webOS 5 is 68). The app and its libraries use them.
const A = Array.prototype as unknown as Record<string, unknown>
if (!A.flat) {
  Object.defineProperty(Array.prototype, 'flat', {
    configurable: true, writable: true,
    value: function flat(this: unknown[], depth = 1): unknown[] {
      const out: unknown[] = []
      const add = (list: unknown[], d: number) => {
        for (let i = 0; i < list.length; i++) {
          if (!(i in list)) continue
          const x = list[i]
          if (Array.isArray(x) && d > 0) add(x, d - 1); else out.push(x)
        }
      }
      add(this, Math.floor(Number(depth)) || 0)
      return out
    },
  })
}
if (!A.flatMap) {
  Object.defineProperty(Array.prototype, 'flatMap', {
    configurable: true, writable: true,
    value: function flatMap(this: unknown[], fn: (x: unknown, i: number, list: unknown[]) => unknown, self?: unknown): unknown[] {
      const out: unknown[] = []
      for (let i = 0; i < this.length; i++) {
        if (!(i in this)) continue
        const x = fn.call(self, this[i], i, this)
        if (Array.isArray(x)) for (const y of x) out.push(y); else out.push(x)
      }
      return out
    },
  })
}
const O = Object as unknown as Record<string, unknown>
if (!O.fromEntries) {
  O.fromEntries = (entries: Iterable<[PropertyKey, unknown]>) => {
    const out: Record<PropertyKey, unknown> = {}
    for (const [k, v] of entries) out[k] = v
    return out
  }
}
