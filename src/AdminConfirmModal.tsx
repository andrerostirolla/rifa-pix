import { useState } from 'react'
import { SecretField } from './SecretField'

type Props = {
  title: string
  description: string
  /** Aviso extra em destaque (ex.: operação destrutiva) */
  warning?: string
  confirmLabel: string
  adminHint: string
  busy?: boolean
  error?: string | null
  danger?: boolean
  onCancel: () => void
  onConfirm: (adminPassword: string) => void
}

/** Confirmação de operação sensível do ADM — só a senha do ADM, sem PIN de membro. */
export function AdminConfirmModal({
  title,
  description,
  warning,
  confirmLabel,
  adminHint,
  busy,
  error,
  danger,
  onCancel,
  onConfirm,
}: Props) {
  const [adminPassword, setAdminPassword] = useState('')
  const canConfirm = Boolean(adminPassword.trim()) && !busy

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="adm-confirm-title">
      <form
        className="panel modal-card"
        onSubmit={(e) => {
          e.preventDefault()
          if (!canConfirm) return
          onConfirm(adminPassword)
        }}
      >
        <div className="panel-head">
          <div>
            <h2 id="adm-confirm-title">{title}</h2>
            <p>{description}</p>
          </div>
        </div>

        {warning ? <p className="form-error">{warning}</p> : null}

        <div className="form-grid">
          <SecretField
            label="Senha do ADM"
            hint={adminHint}
            value={adminPassword}
            onChange={setAdminPassword}
            autoFocus
          />
        </div>

        {error ? <p className="form-error">{error}</p> : null}

        <div className="btn-row">
          <button type="submit" className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} disabled={!canConfirm}>
            {busy ? 'Processando…' : confirmLabel}
          </button>
          <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={busy}>
            Cancelar
          </button>
        </div>
      </form>
    </div>
  )
}
