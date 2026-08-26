import { useCloudSync } from './lib/cloudSyncContext'

/**
 * Contingência só para membro vendendo sem nuvem.
 * ADM vê aviso leve (não bloqueia o painel).
 */
export function CloudRequiredBanner() {
  const { status, error, cloudOk, mode } = useCloudSync()
  if (cloudOk && status !== 'offline') return null

  if (mode === 'admin') {
    return (
      <div className="cloud-admin-warn" role="status">
        Sem sync momentâneo{error ? `: ${error}` : ''}. Dados locais seguem na tela — toque em reconectar se precisar.
        <button type="button" className="linkish" onClick={() => window.location.reload()}>
          Reconectar
        </button>
      </div>
    )
  }

  return (
    <div className="cloud-contingency-banner" role="status">
      <div className="cloud-contingency-inner">
        <p className="cloud-contingency-title">MODO CONTINGÊNCIA — SEM NUVEM</p>
        <p className="cloud-contingency-text">
          Pode vender só em <strong>dinheiro</strong> (números ficam reservados neste aparelho).{' '}
          <strong>PIX bloqueado</strong> até “Nuvem ok”. Ao voltar a rede, as vendas sobem sozinhas.
          {error ? (
            <>
              <br />
              <span className="hint">{error}</span>
            </>
          ) : null}
        </p>
        <button type="button" className="btn btn-secondary cloud-contingency-btn" onClick={() => window.location.reload()}>
          Tentar reconectar
        </button>
      </div>
    </div>
  )
}
