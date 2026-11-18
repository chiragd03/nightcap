import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'

// An optional handler in src/private/handler.ts, not kept in git. Dev servers use it when present; a
// build includes it only with NIGHTCAP_PRIVATE_HANDLER=1 (and stops if it isn't there then).
const ID = '@nightcap/private-handler'
const local = fileURLToPath(new URL('./src/private/handler.ts', import.meta.url))
const none = fileURLToPath(new URL('./src/livetvHandler.none.ts', import.meta.url))
const user = fileURLToPath(new URL('./src/livetvHandler.ts', import.meta.url))
/** A build asked to include it. */
const wanted = () => process.env.NIGHTCAP_PRIVATE_HANDLER === '1'

export function privateHandler(): Plugin {
  let serve = false
  return {
    name: 'nightcap-private-handler',
    enforce: 'pre',
    configResolved(c) {
      serve = c.command === 'serve'
      if (!serve && wanted() && !existsSync(local)) throw new Error('NIGHTCAP_PRIVATE_HANDLER=1, but src/private/handler.ts isn\'t there')
    },
    resolveId(id) { if (id === ID) return (serve || wanted()) && existsSync(local) ? local : none },
    configureServer(server) {
      server.watcher.add(local)
      const changed = (file: string) => {
        if (file !== local) return
        // (livetvHandler.ts asks again which one, and the page loads again with it.)
        for (const m of server.moduleGraph.getModulesByFile(user) ?? []) server.moduleGraph.invalidateModule(m)
        server.ws.send({ type: 'full-reload' })
      }
      server.watcher.on('add', changed)
      server.watcher.on('unlink', changed)
    },
  }
}
