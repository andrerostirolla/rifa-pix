import { useEffect, useState } from 'react'
import { useCloudSync } from './lib/cloudSyncContext'

/**
 * Contingência: aviso único (some sozinho). O membro vende em dinheiro
 * e a reconexão roda em silêncio a cada 30s.
 */
export function CloudRequiredBanner() {
  const { status, error, cloudOk, mode, retry } = useCloudSync()
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    if (cloudOk && status !== 'offline') {
      setDismissed(false)
      return
    }
    if (mode !== 'member') return
    const id = window.setTimeout(() => setDismissed(true), 6_000)
    return () => window.clearTimeout(id)
  }, [cloudOk, status, mode])

  if (cloudOk && status !== 'offline') return null
  if (mode === 'member' && dismissed) return null

  if (mode === 'admin') {
    return (
      <div className="cloud-admin-warn" role="status">
        Sem sync momentâneo{error ? `: ${error}` : ''}. A reconexão é automática.
        <button type="button" className="linkish" onClick={retry}>
          Tentar agora
        </button>
      </div>
    )
  }

  return (
    <div className="cloud-contingency-banner" role="status">
      <div className="cloud-contingency-inner">
        <p className="cloud-contingency-title">MODO CONTINGÊNCIA — SEM NUVEM</p>
        <p className="cloud-contingency-text">
          Pode vender só em <strong>dinheiro</strong>. PIX bloqueado até a rede voltar — aí as vendas sobem
          sozinhas, sem você fazer nada.
        </p>
        <button type="button" className="btn btn-secondary cloud-contingency-btn" onClick={() => setDismissed(true)}>
          Entendi
        </button>
      </div>
    </div>
  )
}
