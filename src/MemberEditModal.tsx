import { useState } from 'react'
import { SecretField } from './SecretField'

type Props = {
  member: { id: string; name: string; phone?: string; pin: string }
  error?: string | null
  onCancel: () => void
  onSave: (patch: { name: string; phone?: string; pin: string }) => void
}

/** Edita nome, WhatsApp e PIN do membro sem precisar remover e cadastrar de novo. */
export function MemberEditModal({ member, error, onCancel, onSave }: Props) {
  const [name, setName] = useState(member.name)
  const [phone, setPhone] = useState(member.phone || '')
  const [pin, setPin] = useState(member.pin)

  const changed = name.trim() !== member.name || phone.trim() !== (member.phone || '') || pin.trim() !== member.pin
  const valid = name.trim().length > 0 && pin.trim().length >= 4

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="member-edit-title">
      <form
        className="panel modal-card"
        onSubmit={(e) => {
          e.preventDefault()
          if (!valid || !changed) return
          onSave({ name: name.trim(), phone: phone.trim() || undefined, pin: pin.trim() })
        }}
      >
        <div className="panel-head">
          <div>
            <h2 id="member-edit-title">Editar membro</h2>
            <p>Alterar o PIN desliga o acesso antigo: avise o membro do novo número.</p>
          </div>
        </div>

        <div className="form-grid">
          <label className="full">
            Nome
            <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
          </label>
          <label className="full">
            WhatsApp
            <input value={phone} onChange={(e) => setPhone(e.target.value)} />
          </label>
          <SecretField
            label="PIN (mín. 4)"
            hint="O membro usa este PIN para entrar e para assinar as baixas."
            value={pin}
            onChange={setPin}
            numeric
          />
        </div>

        {error ? <p className="form-error">{error}</p> : null}

        <div className="btn-row">
          <button type="submit" className="btn btn-primary" disabled={!valid || !changed}>
            Salvar alterações
          </button>
          <button type="button" className="btn btn-secondary" onClick={onCancel}>
            Cancelar
          </button>
        </div>
      </form>
    </div>
  )
}
