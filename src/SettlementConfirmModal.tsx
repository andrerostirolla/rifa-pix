import { useState } from 'react'
import { SecretField } from './SecretField'
import { brl } from './store'

export type SettlementLine = {
  id: string
  buyerName: string
  numbers: string
  amount: number
}

type Props = {
  memberName: string
  lines: SettlementLine[]
  total: number
  adminHint: string
  busy?: boolean
  error?: string | null
  onCancel: () => void
  onConfirm: (adminPassword: string, memberPin: string) => void
}

/** Baixa de dinheiro assinada por ADM + membro, sem expor as senhas na tela. */
export function SettlementConfirmModal({
  memberName,
  lines,
  total,
  adminHint,
  busy,
  error,
  onCancel,
  onConfirm,
}: Props) {
  const [adminPassword, setAdminPassword] = useState('')
  const [memberPin, setMemberPin] = useState('')

  const canConfirm = Boolean(adminPassword.trim() && memberPin.trim()) && !busy

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="baixa-confirm-title">
      <form
        className="panel modal-card"
        onSubmit={(e) => {
          e.preventDefault()
          if (!canConfirm) return
          onConfirm(adminPassword, memberPin)
        }}
      >
        <div className="panel-head">
          <div>
            <h2 id="baixa-confirm-title">Confirmar baixa em dinheiro</h2>
            <p>
              {memberName} · <strong>{brl(total)}</strong> em {lines.length} venda(s)
            </p>
          </div>
        </div>

        <div className="table-wrap baixa-confirm-list">
          <table>
            <thead>
              <tr>
                <th>Comprador</th>
                <th>Números</th>
                <th>Valor</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.id}>
                  <td>{l.buyerName}</td>
                  <td>{l.numbers}</td>
                  <td>{brl(l.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="form-grid">
          <SecretField
            label="Senha do ADM"
            hint={adminHint}
            value={adminPassword}
            onChange={setAdminPassword}
            autoFocus
          />
          <SecretField
            label={`PIN do membro (${memberName})`}
            hint="O membro digita o PIN dele para assinar a prestação."
            value={memberPin}
            onChange={setMemberPin}
            numeric
          />
        </div>

        {error ? <p className="form-error">{error}</p> : null}

        <div className="btn-row">
          <button type="submit" className="btn btn-primary" disabled={!canConfirm}>
            {busy ? 'Liquidando…' : `Liquidar ${brl(total)}`}
          </button>
          <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={busy}>
            Cancelar
          </button>
        </div>
      </form>
    </div>
  )
}
