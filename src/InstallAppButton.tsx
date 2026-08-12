import { useEffect, useState } from 'react'

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

function isStandalone() {
  const mq = window.matchMedia('(display-mode: standalone)').matches
  const ios = Boolean((navigator as Navigator & { standalone?: boolean }).standalone)
  return mq || ios
}

function isIos() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent)
}

export function InstallAppButton() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null)
  const [installed, setInstalled] = useState(() => (typeof window !== 'undefined' ? isStandalone() : false))
  const [showIosHelp, setShowIosHelp] = useState(false)
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem('rifa-pix-install-dismissed') === '1'
    } catch {
      return false
    }
  })

  useEffect(() => {
    const onBip = (e: Event) => {
      e.preventDefault()
      setDeferred(e as BeforeInstallPromptEvent)
    }
    const onInstalled = () => {
      setInstalled(true)
      setDeferred(null)
    }
    window.addEventListener('beforeinstallprompt', onBip)
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', onBip)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  if (installed || dismissed) return null

  const onInstall = async () => {
    if (deferred) {
      await deferred.prompt()
      const choice = await deferred.userChoice
      if (choice.outcome === 'accepted') setInstalled(true)
      setDeferred(null)
      return
    }
    if (isIos()) {
      setShowIosHelp(true)
      return
    }
    setShowIosHelp(true)
  }

  const hide = () => {
    setDismissed(true)
    setShowIosHelp(false)
    try {
      localStorage.setItem('rifa-pix-install-dismissed', '1')
    } catch {
      /* ignore */
    }
  }

  return (
    <>
      <button type="button" className="btn btn-secondary install-btn" onClick={onInstall}>
        {deferred ? 'Instalar app' : 'Add atalho'}
      </button>

      {showIosHelp && (
        <div className="install-modal" role="dialog" aria-modal="true" aria-labelledby="install-title">
          <div className="install-card panel">
            <h2 id="install-title">Adicionar à tela inicial</h2>
            {isIos() ? (
              <ol className="install-steps">
                <li>
                  Toque em <strong>Compartilhar</strong> <span aria-hidden="true">□↑</span> no Safari
                </li>
                <li>
                  Escolha <strong>Adicionar à Tela de Início</strong>
                </li>
                <li>
                  Confirme em <strong>Adicionar</strong>
                </li>
              </ol>
            ) : (
              <ol className="install-steps">
                <li>Abra o menu do navegador (⋮ ou ⋯)</li>
                <li>
                  Toque em <strong>Instalar app</strong> / <strong>Adicionar à tela inicial</strong>
                </li>
                <li>Confirme — o ícone do RifaPIX aparece na área de trabalho ou na home</li>
              </ol>
            )}
            <p className="hint">No computador (Chrome/Edge): menu → “Instalar RifaPIX…” ou o ícone ⊕ na barra de endereço.</p>
            <div className="btn-row">
              {deferred && (
                <button type="button" className="btn btn-primary" onClick={onInstall}>
                  Instalar agora
                </button>
              )}
              <button type="button" className="btn btn-secondary" onClick={() => setShowIosHelp(false)}>
                Fechar
              </button>
              <button type="button" className="btn btn-ghost" onClick={hide}>
                Não mostrar de novo
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
