import { useCloudSync } from './lib/cloudSyncContext'

/**
 * Aviso de contingência (não bloqueia a tela):
 * sem nuvem → só dinheiro local; PIX bloqueado; sobe quando voltar a rede.
 */
export function CloudRequiredBanner() {
  const { status, error, cloudOk } = useCloudSync()
  if (cloudOk && status !== 'offline') return null

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
