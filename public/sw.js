/* RifaPIX service worker — cache leve para instalação PWA */
const CACHE = 'rifa-pix-shell-v1'

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      cache.addAll([
        '/rifa-pix/',
        '/rifa-pix/index.html',
        '/rifa-pix/manifest.webmanifest',
        '/rifa-pix/icon-192.png',
        '/rifa-pix/icon-512.png',
      ]).catch(() => undefined),
    ),
  )
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
    ),
  )
  self.clients.claim()
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return

  // Network-first for app shell; cache fallback
  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone()
        if (res.ok && (url.pathname.startsWith('/rifa-pix/') || url.pathname.endsWith('.js') || url.pathname.endsWith('.css'))) {
          caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => undefined)
        }
        return res
      })
      .catch(() => caches.match(req).then((cached) => cached || caches.match('/rifa-pix/index.html'))),
  )
})
