import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Plugin } from 'vite'

// The web app's service worker (sw.template.js), written for each build with the build's id and its
// files. The id is also in the page (a meta tag: not in the code, whose files would all be renamed
// with each build), so the worker can tell the page is its own, and a tab can tell a newer build has
// taken over.
const BUILD = Date.now().toString(36) + randomBytes(3).toString('hex')

/** Kept from the start besides the built files: the mark "Waking up" shows. (An avatar is kept the
 * first time it's shown: the household's few, not all 28.) */
const PUBLIC = ['brand/mark.png']

export function appWorker(): Plugin {
  let base = '/app/'
  let outDir = 'dist'
  let publicDir = 'public'
  return {
    name: 'nightcap-app-worker',
    configResolved(c) { base = c.base; outDir = c.build.outDir; publicDir = c.publicDir },
    transformIndexHtml: () => [{ tag: 'meta', attrs: { name: 'nightcap-build', content: BUILD }, injectTo: 'head' }],
    writeBundle(_, bundle) {
      const keep: string[] = []
      const files = [base]
      // Kept on installing: what the first page needs (the entry, what it imports, their styles) and
      // the fonts' common letters. Every other screen is kept the first time it's opened (KEEP): a
      // deploy doesn't send every device every screen again.
      const needed = new Set<string>()
      const add = (name: string) => {
        const out = bundle[name]
        if (!out || needed.has(name)) return
        needed.add(name)
        if (out.type !== 'chunk') return
        out.imports.forEach(add)
        out.viteMetadata?.importedCss.forEach(css => needed.add(css))
      }
      for (const [name, out] of Object.entries(bundle)) if (out.type === 'chunk' && out.isEntry) add(name)
      for (const [name, out] of Object.entries(bundle)) {
        if (name === 'index.html' || name.endsWith('.map')) continue
        keep.push(base + name)
        const font = out.type === 'asset' && name.endsWith('.woff2') && !name.includes('-latin-ext-')
        if (needed.has(name) || font) files.push(base + name)
      }
      for (const f of PUBLIC) if (existsSync(join(publicDir, f))) files.push(base + f)
      const code = readFileSync(new URL('./sw.template.js', import.meta.url), 'utf8')
        .replace('__BUILD__', JSON.stringify(BUILD))
        .replace('__FILES__', JSON.stringify(files))
        .replace('__KEEP__', JSON.stringify(keep))
      writeFileSync(join(outDir, 'sw.js'), code)
    },
  }
}
