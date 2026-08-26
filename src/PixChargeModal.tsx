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
  /** Reabertura de um PIX que já estava na lista */
  reopened?: boolean
  onCancel: () => void
  onClosePaid: () => void
  /** Deixa o PIX em aberto e libera a tela para a próxima venda */
  onNewSale?: () => void
}

function formatRemain(ms: number) {
  if (ms <= 0) return 'expirado'
  const m = Math.floor(ms / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  return `${m}min ${String(s).padStart(2, '0')}s`
}

function totalMinutes(ms: number) {
  return Math.max(1, Math.round(ms / 60000))
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
  reopened,
  onCancel,
  onClosePaid,
  onNewSale,
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
          A venda <strong>só é efetivada</strong> quando o pagamento cair na conta da loja. A consulta é
          automática a cada segundo.
          {remainMs != null ? (
            <>
              <br />
              Este PIX fica em aberto por <strong>{totalMinutes(remainMs)} minuto(s)</strong> — vence às{' '}
              <strong>{new Date(expiresAt!).toLocaleTimeString('pt-BR')}</strong>. Faltam{' '}
              <strong>{formatRemain(remainMs)}</strong>.
              {remainMs <= 0 ? (
                <>
                  <br />
                  <strong>QR expirado.</strong> A venda foi cancelada e os números voltaram para você.
                </>
              ) : (
                <>
                  <br />
                  Se ninguém pagar até lá, a venda é <strong>cancelada sozinha</strong> e os números voltam a
                  ficar livres.
                </>
              )}
            </>
          ) : (
            <>
              <br />
              O QR costuma valer cerca de <strong>30 minutos</strong>. Depois disso a venda é cancelada e os
              números voltam a ficar livres.
            </>
          )}
          {onNewSale ? (
            <>
              <br />
              Pode fechar esta tela em <strong>Nova venda</strong>: o PIX continua valendo e você reabre este
              QR pelo status <strong>Aguardando PIX</strong> na lista.
            </>
          ) : null}
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
          {onNewSale ? (
            <button type="button" className="btn btn-secondary" onClick={onNewSale}>
              {reopened ? 'Fechar' : 'Nova venda'}
            </button>
          ) : null}
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
