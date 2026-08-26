import { useState } from 'react'

const QUICK = [
  'Comprador desistiu',
  'Vai pagar em dinheiro',
  'Número errado na venda',
  'Comprador não conseguiu pagar',
  'Venda duplicada',
]

type Props = {
  buyerName: string
  numbers: string
  amount: string
  busy?: boolean
  onCancel: () => void
  onConfirm: (reason: string) => void
}

/** Pede o motivo antes de cancelar um PIX em aberto — fica registrado para o ADM auditar. */
export function CancelReasonModal({ buyerName, numbers, amount, busy, onCancel, onConfirm }: Props) {
  const [reason, setReason] = useState('')
  const canConfirm = reason.trim().length >= 3 && !busy

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="cancel-reason-title">
      <form
        className="panel modal-card"
        onSubmit={(e) => {
          e.preventDefault()
          if (!canConfirm) return
          onConfirm(reason.trim())
        }}
      >
        <div className="panel-head">
          <div>
            <h2 id="cancel-reason-title">Cancelar este PIX?</h2>
            <p>
              {buyerName} · nº {numbers} · {amount}
            </p>
          </div>
        </div>

        <p className="hint">
          Os números voltam a ficar livres e a venda fica registrada como <strong>Cancelado por membro</strong>.
          O motivo aparece para o administrador.
        </p>

        <div className="reason-chips">
          {QUICK.map((q) => (
            <button
              key={q}
              type="button"
              className={`chip ${reason === q ? 'chip-on' : ''}`}
              onClick={() => setReason(q)}
            >
              {q}
            </button>
          ))}
        </div>

        <div className="form-grid">
          <label className="full">
            Motivo do cancelamento
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              maxLength={200}
              placeholder="Escreva ou escolha uma opção acima"
              autoFocus
            />
          </label>
        </div>

        <div className="btn-row">
          <button type="submit" className="btn btn-danger" disabled={!canConfirm}>
            {busy ? 'Cancelando…' : 'Cancelar o PIX'}
          </button>
          <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={busy}>
            Voltar
          </button>
        </div>
      </form>
    </div>
  )
}
