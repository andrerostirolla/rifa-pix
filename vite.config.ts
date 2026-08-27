import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { writeFileSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Gera app-version.json a cada build/dev para forçar celulares a atualizar. */
function appVersionPlugin(): Plugin {
  const buildId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const builtAt = new Date().toISOString()
  const payload = JSON.stringify({ buildId, builtAt }, null, 2)

  return {
    name: 'rifapix-app-version',
    config() {
      return {
        define: {
          __APP_BUILD_ID__: JSON.stringify(buildId),
        },
      }
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url || ''
        if (url.includes('app-version.json')) {
          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Cache-Control', 'no-store')
          res.end(payload)
          return
        }
        next()
      })
    },
    writeBundle(options) {
      const outDir = options.dir || join(process.cwd(), 'dist')
      mkdirSync(outDir, { recursive: true })
      writeFileSync(join(outDir, 'app-version.json'), payload)
    },
  }
}

/** Injeta no service worker a lista de arquivos do dist para o app abrir sem rede. */
function swPrecachePlugin(): Plugin {
  return {
    name: 'rifapix-sw-precache',
    closeBundle() {
      const outDir = join(process.cwd(), 'dist')
      const swPath = join(outDir, 'sw.js')
      let sw: string
      try {
        sw = readFileSync(swPath, 'utf8')
      } catch {
        return
      }
      const base = process.env.VITE_BASE || '/rifa-pix/'
      const urls: string[] = []
      const walk = (dir: string, rel: string) => {
        for (const name of readdirSync(dir)) {
          const full = join(dir, name)
          const nextRel = rel ? `${rel}/${name}` : name
          if (statSync(full).isDirectory()) {
            walk(full, nextRel)
            continue
          }
          if (name === 'sw.js' || name === 'app-version.json') continue
          urls.push(`${base}${nextRel}`.replace(/\\/g, '/').replace(/\/{2,}/g, '/'))
        }
      }
      walk(outDir, '')
      urls.unshift(`${base}`, `${base}index.html`)
      const unique = [...new Set(urls)]
      const next = sw.replace('[] // PRECACHE_INJECT', `${JSON.stringify(unique)} // PRECACHE_INJECT`)
      writeFileSync(swPath, next)
    },
  }
}

export default defineConfig({
  plugins: [react(), appVersionPlugin(), swPrecachePlugin()],
  base: process.env.VITE_BASE || '/rifa-pix/',
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
  },
})
