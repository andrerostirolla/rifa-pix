export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return
  const base = import.meta.env.BASE_URL || '/rifa-pix/'

  const tickUpdate = async () => {
    try {
      const reg = await navigator.serviceWorker.getRegistration(base)
      await reg?.update()
    } catch {
      /* ignore */
    }
  }

  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register(`${base}sw.js`, { scope: base, updateViaCache: 'none' })
      .then((reg) => {
        // Força checagem logo e a cada abertura / foco
        void reg.update()
        window.setInterval(() => void reg.update(), 30_000)
      })
      .catch((err) => {
        console.warn('SW não registrado', err)
      })
  })

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void tickUpdate()
  })
  window.addEventListener('focus', () => void tickUpdate())
  window.addEventListener('online', () => void tickUpdate())
}
