// The web build's sizes against their budgets: what the first page
// load fetches before anything else (the entry script, its modulepreloads and the entry CSS), gzip,
// with Brotli beside it (what the server sends). Exits 1 when over a budget.
//   node size.mjs [dist folder, default ../dist]

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const dist = path.resolve(import.meta.dirname, process.argv[2] ?? '../dist')
const BUDGET = { js: 118, css: 10 } // KB, gzip

const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8')
const files = (re) => [...html.matchAll(re)].map((m) => m[1])
const js = [...files(/<script[^>]+src="\/app\/([^"]+)"/g), ...files(/<link rel="modulepreload"[^>]*href="\/app\/([^"]+)"/g)]
const css = files(/<link rel="stylesheet"[^>]*href="\/app\/([^"]+)"/g)

const kb = (n) => +(n / 1024).toFixed(1)
const sizes = (f) => {
  const b = fs.readFileSync(path.join(dist, f))
  return { file: f, raw: kb(b.length), gzip: kb(zlib.gzipSync(b, { level: 9 }).length), brotli: kb(zlib.brotliCompressSync(b).length) }
}
const sum = (list, k) => +list.reduce((a, x) => a + x[k], 0).toFixed(1)

let over = false
for (const [name, list] of [['js', js.map(sizes)], ['css', css.map(sizes)]]) {
  for (const x of list) console.log(`  ${x.file}  ${x.gzip} KB gzip, ${x.brotli} KB br`)
  const total = sum(list, 'gzip')
  const ok = total <= BUDGET[name]
  over ||= !ok
  console.log(`${name.toUpperCase()} initial: ${total} KB gzip (${sum(list, 'brotli')} KB br), budget ${BUDGET[name]} KB ${ok ? 'ok' : 'OVER'}\n`)
}
process.exit(over ? 1 : 0)
