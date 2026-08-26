import { useCallback, useEffect, useState } from 'react'

declare const __APP_BUILD_ID__: string

type VersionPayload = {
  buildId: string
  builtAt?: string
}

function versionUrl() {
  const base = import.meta.env.BASE_URL || '/rifa-pix/'
  return `${base}app-version.json?t=${Date.now()}`
}

async function hardReload() {
  try {
    if ('caches' in window) {
      const keys = await caches.keys()
      await Promise.all(keys.map((k) => caches.delete(k)))
    }
  } catch {
    /* ignore */
  }
  try {
    const regs = await navigator.serviceWorker?.getRegistrations()
    if (regs) {
      for (const reg of regs) {
        reg.waiting?.postMessage('SKIP_WAITING')
        reg.active?.postMessage('CLEAR_CACHES')
      }
    }
  } catch {
    /* ignore */
  }
  const base = import.meta.env.BASE_URL || '/rifa-pix/'
  window.location.replace(`${base}?v=${Date.now()}`)
}

/** Banner piscante quando o celular ainda está com JS/CSS antigo (PWA/cache). */
export function AppUpdateBanner() {
  const [available, setAvailable] = useState(false)
  const [remoteBuiltAt, setRemoteBuiltAt] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)

  const check = useCallback(async () => {
    setChecking(true)
    try {
      const res = await fetch(versionUrl(), { cache: 'no-store' })
      if (!res.ok) return
      const data = (await res.json()) as VersionPayload
      if (!data?.buildId) return
      const local = typeof __APP_BUILD_ID__ !== 'undefined' ? __APP_BUILD_ID__ : ''
      if (local && data.buildId !== local) {
        setAvailable(true)
        setRemoteBuiltAt(data.builtAt || null)
      }
    } catch {
      /* offline — não force update */
    } finally {
      setChecking(false)
    }
  }, [])

  useEffect(() => {
    void check()
    const id = window.setInterval(() => void check(), 20_000)
    const onVis = () => {
      if (document.visibilityState === 'visible') void check()
    }
    const onFocus = () => void check()
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('focus', onFocus)
    window.addEventListener('online', onFocus)

    // SW nova instalada / controlando
    let onController: (() => void) | undefined
    if ('serviceWorker' in navigator) {
      onController = () => setAvailable(true)
      navigator.serviceWorker.addEventListener('controllerchange', onController)
      void navigator.serviceWorker.getRegistration().then((reg) => {
        if (!reg) return
        void reg.update()
        if (reg.waiting) setAvailable(true)
        reg.addEventListener('updatefound', () => {
          const worker = reg.installing
          if (!worker) return
          worker.addEventListener('statechange', () => {
            if (worker.state === 'installed' && navigator.serviceWorker.controller) {
              setAvailable(true)
            }
          })
        })
      })
    }

    return () => {
      window.clearInterval(id)
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('online', onFocus)
      if (onController) navigator.serviceWorker.removeEventListener('controllerchange', onController)
    }
  }, [check])

  if (!available) return null

  return (
    <div className="app-update-banner" role="alert">
      <div className="app-update-banner-inner">
        <p className="app-update-title">NOVA ATUALIZAÇÃO DISPONÍVEL</p>
        <p className="app-update-text">
          Este aparelho ainda está com uma versão antiga do RifaPIX. Toque em atualizar para carregar as vendas
          online e as últimas melhorias.
          {remoteBuiltAt ? (
            <>
              <br />
              <span className="hint">Publicado: {new Date(remoteBuiltAt).toLocaleString('pt-BR')}</span>
            </>
          ) : null}
        </p>
        <button type="button" className="btn btn-primary app-update-btn" disabled={checking} onClick={() => void hardReload()}>
          Atualizar agora
        </button>
      </div>
    </div>
  )
}
