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

  const register = () => {
    navigator.serviceWorker
      .register(`${base}sw.js`, { scope: base, updateViaCache: 'none' })
      .then((reg) => {
        void reg.update()
      })
      .catch((err) => {
        console.warn('SW não registrado', err)
      })
  }

  register()
  window.addEventListener('load', () => void tickUpdate())

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void tickUpdate()
  })
  window.addEventListener('focus', () => void tickUpdate())
  window.addEventListener('online', () => void tickUpdate())
}
