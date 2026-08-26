import { useState } from 'react'
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

function EyeIcon({ off }: { off?: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.7" />
      {off ? <path d="M4 20 20 4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /> : null}
    </svg>
  )
}

function SecretField({
  label,
  hint,
  value,
  onChange,
  autoFocus,
  numeric,
}: {
  label: string
  hint?: string
  value: string
  onChange: (v: string) => void
  autoFocus?: boolean
  numeric?: boolean
}) {
  const [shown, setShown] = useState(false)
  return (
    <label className="full">
      {label}
      <span className="secret-field">
        <input
          type={shown ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoFocus={autoFocus}
          autoComplete="off"
          inputMode={numeric && shown ? 'numeric' : undefined}
        />
        <button
          type="button"
          className="secret-toggle"
          onClick={() => setShown((v) => !v)}
          aria-label={shown ? `Esconder ${label}` : `Mostrar ${label}`}
          title={shown ? 'Esconder' : 'Mostrar'}
        >
          <EyeIcon off={shown} />
        </button>
      </span>
      {hint ? <span className="hint">{hint}</span> : null}
    </label>
  )
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
