/* RifaPIX service worker — network-first; não prende o app em versão antiga */
const CACHE = 'rifa-pix-shell-v5'

self.addEventListener('install', (event) => {
  // Ativa imediatamente a SW nova (sem esperar fechar todas as abas)
  event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting()
  }
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

  // Sempre rede fresca para checagem de versão
  if (url.pathname.endsWith('app-version.json')) {
    event.respondWith(fetch(req, { cache: 'no-store' }))
    return
  }

  // HTML / navegação: só rede (fallback cache se offline)
  const isNav = req.mode === 'navigate'
  const isHtml =
    url.pathname.endsWith('.html') ||
    url.pathname === '/rifa-pix/' ||
    url.pathname === '/rifa-pix'
  if (isNav || isHtml) {
    event.respondWith(
      fetch(req, { cache: 'no-store' }).catch(() =>
        caches.match('/rifa-pix/index.html').then((c) => c || Response.error()),
      ),
    )
    return
  }

  // JS/CSS/ícones: rede primeiro, guarda cópia para uso offline
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone()
          caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => undefined)
        }
        return res
      })
      .catch(() => caches.match(req).then((cached) => cached || Response.error())),
  )
})
