// Class names given styles in more than one of the web app's stylesheets. With screens fetched when
// first opened, their stylesheets arrive later and in any order, so a class two sheets both style
// looks different depending on which screens have been opened. Prints each with its sheets; exits 1
// when any is found outside the allowed list.
//   node css-clash.mjs

import fs from 'node:fs'
import path from 'node:path'

const src = path.resolve(import.meta.dirname, '../src')
/** Shared on purpose: the base style is in a sheet every user of it imports, and the others only add
 * a second class of their own (".btn.danger", ".card.episode"), or a screen imports another's sheet
 * for its look (Owner imports Settings.css, Setup.css and Profiles.css; LiveTv imports Player.css). */
const ALLOWED = new Set(['btn', 'card', 'poster', 'mark', 'panel-item', 'pn-item', 'pn-hint', 'setup-lead', 'setup-tile', 'who-content'])

const sheets = []
const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (f.name.endsWith('.css')) sheets.push(p) } }
walk(src)

const where = new Map()
for (const file of sheets) {
  const css = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  for (const rule of css.matchAll(/([^{}]+)\{/g)) {
    for (const sel of rule[1].split(',')) {
      const s = sel.trim()
      if (!s || s.startsWith('@') || /^(from|to|\d+%)$/.test(s)) continue
      // Only a selector that starts with the class itself (".x", ".x:hover", ".x .y"): one scoped under
      // another class (".screen .x") belongs to its screen.
      const m = s.match(/^\.([\w-]+)/)
      if (m) { const set = where.get(m[1]) ?? new Set(); set.add(path.relative(src, file)); where.set(m[1], set) }
    }
  }
  for (const k of css.matchAll(/@keyframes\s+([\w-]+)/g)) { const key = '@keyframes ' + k[1]; const set = where.get(key) ?? new Set(); set.add(path.relative(src, file)); where.set(key, set) }
}
let bad = 0
for (const [name, files] of [...where].sort()) {
  if (files.size < 2) continue
  const ok = ALLOWED.has(name)
  if (!ok) bad++
  console.log(`${ok ? '  (allowed) ' : ''}${name.startsWith('@') ? name : '.' + name}: ${[...files].join(', ')}`)
}
process.exit(bad ? 1 : 0)
