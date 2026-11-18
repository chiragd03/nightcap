import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { appWorker } from './appWorker.ts'
import { privateHandler } from './privateHandler.ts'

// The Nightcap server the dev server forwards API calls to. In production the server serves
// this app itself, so every call is relative and no address is needed.
const server = process.env.NIGHTCAP_SERVER ?? 'http://localhost:7171'
const api = { target: server, changeOrigin: true }

/** The fonts Home's first paint uses, fetched with the page rather than once its styles are read. */
const preloadFonts = (): Plugin => ({
  name: 'nightcap-preload-fonts',
  transformIndexHtml: {
    order: 'post',
    handler: (_, ctx) => Object.keys(ctx.bundle ?? {})
      .filter(f => /\/(hanken|big_shoulders)-latin-[\w-]+\.woff2$/.test(f) && !f.includes('-latin-ext-'))
      .map(f => ({ tag: 'link', attrs: { rel: 'preload', as: 'font', type: 'font/woff2', href: `/app/${f}`, crossorigin: '' }, injectTo: 'head' as const })),
  },
})

export default defineConfig({
  base: '/app/',
  plugins: [react(), privateHandler(), appWorker(), preloadFonts()],
  server: {
    proxy: { '/launcher': api, '/household': api, '/server': api, '/join': api, '/ready': api, '/s/': api, '/limits.json': api, '/livetv': api },
  },
})
