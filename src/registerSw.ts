export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return
  const base = import.meta.env.BASE_URL || '/rifa-pix/'
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${base}sw.js`, { scope: base }).catch((err) => {
      console.warn('SW não registrado', err)
    })
  })
}
