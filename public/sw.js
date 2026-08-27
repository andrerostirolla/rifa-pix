/* RifaPIX service worker — abre offline com o que já foi guardado neste aparelho. */
const CACHE = 'rifa-pix-shell-v6'
const BASE = '/rifa-pix/'
/** Preenchido no build com os arquivos do dist (HTML, JS, CSS, ícones). */
const PRECACHE = [] // PRECACHE_INJECT

const NET_WAIT_MS = 3500

function timeout(ms) {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error('timeout')), ms)
  })
}

async function putBoth(cache, res) {
  await cache.put(BASE, res.clone())
  await cache.put(`${BASE}index.html`, res.clone())
}

async function cacheShell() {
  const cache = await caches.open(CACHE)
  const toCache = PRECACHE.length
    ? PRECACHE
    : [`${BASE}`, `${BASE}index.html`, `${BASE}manifest.webmanifest`]

  await Promise.all(
    toCache.map(async (url) => {
      try {
        const res = await fetch(url, { cache: 'reload' })
        if (!res.ok) return
        if (url === BASE || url === `${BASE}index.html` || url.endsWith('/')) {
          await putBoth(cache, res)
        } else {
          await cache.put(url, res)
        }
      } catch {
        /* um arquivo falhou — segue com os outros */
      }
    }),
  )

  try {
    const htmlRes = await fetch(`${BASE}index.html`, { cache: 'reload' })
    if (htmlRes.ok) {
      await putBoth(cache, htmlRes)
      const text = await caches.match(`${BASE}index.html`).then((r) => (r ? r.text() : ''))
      const assets = [...String(text).matchAll(/(?:src|href)="(\/rifa-pix\/[^"]+)"/g)].map((m) => m[1])
      await Promise.all(
        assets.map(async (url) => {
          try {
            const r = await fetch(url, { cache: 'reload' })
            if (r.ok) await cache.put(url, r)
          } catch {
            /* ignore */
          }
        }),
      )
    }
  } catch {
    /* sem rede na instalação */
  }

  // Se esta SW instalou sem rede, herda o HTML/JS da versão anterior
  if (!(await cache.match(`${BASE}index.html`))) {
    const keys = await caches.keys()
    for (const key of keys) {
      if (key === CACHE) continue
      const old = await caches.open(key)
      const html = await old.match(`${BASE}index.html`)
      if (!html) continue
      const reqs = await old.keys()
      await Promise.all(
        reqs.map(async (r) => {
          const res = await old.match(r)
          if (res) await cache.put(r, res)
        }),
      )
      break
    }
  }
}

async function cachedShell() {
  const cache = await caches.open(CACHE)
  return (
    (await cache.match(`${BASE}index.html`, { ignoreSearch: true })) ||
    (await cache.match(BASE, { ignoreSearch: true })) ||
    (await cache.match(new Request(BASE), { ignoreSearch: true }))
  )
}

function offlineHint() {
  return new Response(
    `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>RifaPIX</title><body style="font-family:system-ui,sans-serif;padding:2rem 1.25rem;text-align:center;color:#14221c;background:#eef5f1"><h1 style="color:#0f7a5f">RifaPIX</h1><p>Sem internet e este aparelho ainda não guardou o aplicativo.</p><p>Abra uma vez <strong>com rede</strong> para poder vender em contingência depois.</p></body></html>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  )
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    cacheShell()
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE)
      const ready = await cache.match(`${BASE}index.html`)
      if (ready) {
        const keys = await caches.keys()
        await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      }
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting()
  if (event.data === 'CLEAR_CACHES') {
    event.waitUntil(caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))))
  }
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return

  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return
  if (!url.pathname.startsWith('/rifa-pix')) return

  if (url.pathname.endsWith('app-version.json') || url.pathname.endsWith('/sw.js')) {
    event.respondWith(fetch(req, { cache: 'no-store' }))
    return
  }

  const isNav = req.mode === 'navigate'
  const isHtml =
    url.pathname.endsWith('.html') || url.pathname === '/rifa-pix/' || url.pathname === '/rifa-pix'

  if (isNav || isHtml) {
    event.respondWith(
      (async () => {
        try {
          const fresh = await Promise.race([fetch(req, { cache: 'no-store' }), timeout(NET_WAIT_MS)])
          if (fresh && fresh.ok) {
            const cache = await caches.open(CACHE)
            await putBoth(cache, fresh)
            return fresh
          }
        } catch {
          /* offline, Wi‑Fi sem internet, ou rede lenta demais */
        }
        return (await cachedShell()) || offlineHint()
      })(),
    )
    return
  }

  event.respondWith(
    (async () => {
      const cached = await caches.match(req, { ignoreSearch: true })
      try {
        const fresh = await Promise.race([fetch(req), timeout(NET_WAIT_MS)])
        if (fresh && fresh.ok) {
          const cache = await caches.open(CACHE)
          cache.put(req, fresh.clone()).catch(() => undefined)
          return fresh
        }
      } catch {
        /* usa o cache */
      }
      if (cached) return cached
      if (req.destination === 'document') return (await cachedShell()) || offlineHint()
      return Response.error()
    })(),
  )
})
