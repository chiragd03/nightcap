import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { privateHandler } from './privateHandler.ts'

// The TV app for Samsung (Tizen) and LG (webOS) TVs: built next to the web app and served by the
// Nightcap server at /app/tv/. It targets the
// browser engines of 2020 TVs (Tizen 5.5 and webOS 5: Chromium 68/69), so newer syntax and CSS are
// lowered. Dev: `npm run dev:tv`, then open http://localhost:5177/app/tv/ (arrow keys = the remote).
const server = process.env.NIGHTCAP_SERVER ?? 'http://localhost:7171'
const api = { target: server, changeOrigin: true }

export default defineConfig({
  root: 'tv',
  // (Its own cache of dependencies: the web app's dev server runs beside it with another.)
  cacheDir: '../node_modules/.vite-tv',
  base: '/app/tv/',
  plugins: [react(), privateHandler()],
  build: {
    outDir: '../dist/tv',
    emptyOutDir: true,
    target: 'chrome68',
    cssTarget: 'chrome68',
  },
  server: {
    port: 5177,
    proxy: {
      '/launcher': api, '/household': api, '/livetv': api, '/join': api, '/ready': api, '/s/': api, '/limits.json': api,
      // The fonts and avatars are the web app's (served at /app/ by the server).
      '^/app/(fonts|avatars|brand)/': api,
    },
  },
})
