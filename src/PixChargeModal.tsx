import { useEffect, useMemo, useState } from 'react'
import { qrImageUrl } from './lib/pixWorkspace'
import { brl } from './store'

type Props = {
  buyerName: string
  amount: number
  copyPaste: string
  txid: string
  isDemo?: boolean
  checking?: boolean
  paid?: boolean
  expiresAt?: string
  onCancel: () => void
  onClosePaid: () => void
}

function formatRemain(ms: number) {
  if (ms <= 0) return 'expirado'
  const m = Math.floor(ms / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  return `${m}min ${String(s).padStart(2, '0')}s`
}

export function PixChargeModal({
  buyerName,
  amount,
  copyPaste,
  txid,
  isDemo,
  checking,
  paid,
  expiresAt,
  onCancel,
  onClosePaid,
}: Props) {
  const [copied, setCopied] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (paid || !expiresAt) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [paid, expiresAt])

  const remainMs = useMemo(() => {
    if (!expiresAt) return null
    return new Date(expiresAt).getTime() - now
  }, [expiresAt, now])

  const copyPix = async () => {
    try {
      await navigator.clipboard.writeText(copyPaste)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      /* ignore */
    }
  }

  if (paid) {
    return (
      <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="pix-done-title">
        <div className="panel modal-card pix-charge-modal">
          <div className="panel-head">
            <div>
              <h2 id="pix-done-title">Recebido com sucesso</h2>
              <p>
                Venda PIX para <strong>{buyerName}</strong> no valor <strong>{brl(amount)}</strong> recebida com
                sucesso.
              </p>
            </div>
            <button type="button" className="btn btn-primary" onClick={onClosePaid}>
              OK
            </button>
          </div>
          <p className="hint">
            TXID: <code>{txid}</code>
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="pix-charge-title">
      <div className="panel modal-card pix-charge-modal">
        <div className="panel-head">
          <div>
            <h2 id="pix-charge-title">Aguardando PIX</h2>
            <p>
              {buyerName} · {brl(amount)}
            </p>
          </div>
          <button type="button" className="btn btn-danger" onClick={onCancel}>
            Cancelar venda
          </button>
        </div>

        <p className="pix-wait-banner">
          A venda <strong>só é efetivada</strong> quando o pagamento cair na conta da loja.
          <br />
          Pode demorar alguns minutos — a consulta é automática a cada segundo. Não feche esta tela.
          {remainMs != null ? (
            <>
              <br />
              Tempo do QR: <strong>{formatRemain(remainMs)}</strong> (em geral até ~30 minutos).
              {remainMs <= 0 ? (
                <>
                  <br />
                  <strong>QR expirado.</strong> Cancele a venda e gere um PIX novo se o comprador ainda for pagar.
                </>
              ) : null}
            </>
          ) : (
            <>
              <br />
              O QR costuma valer cerca de <strong>30 minutos</strong> — pode esperar sem pressa.
            </>
          )}
        </p>

        {isDemo ? (
          <p className="demo-pix-warn">
            <strong>PIX demo</strong> — não paga no banco. Configure Sicoob no Supabase.
          </p>
        ) : null}

        {copyPaste ? (
          <div className="pix-qr-wrap">
            <img src={qrImageUrl(copyPaste)} alt="QR Code PIX" width={240} height={240} />
          </div>
        ) : null}

        <label className="full">
          Copia e cola
          <textarea readOnly rows={4} value={copyPaste} onFocus={(e) => e.target.select()} />
        </label>

        <div className="btn-row">
          <button type="button" className="btn btn-primary" onClick={copyPix}>
            {copied ? 'Copiado!' : 'Copiar PIX'}
          </button>
        </div>

        <p className="hint pix-waiting">
          {checking ? 'Consultando Sicoob…' : 'Aguardando pagamento…'}
          <br />
          TXID: <code>{txid}</code>
        </p>
      </div>
    </div>
  )
}
