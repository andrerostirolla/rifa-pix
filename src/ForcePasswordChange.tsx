import { useState } from 'react'
import type { FormEvent } from 'react'
import { supabase } from './lib/supabase'

type Props = {
  onDone: () => void
}

/** Obrigatório no 1º login de ADM auxiliar / acesso total. */
export function ForcePasswordChange({ onDone }: Props) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!supabase) return
    setError(null)
    setBusy(true)
    const fd = new FormData(e.currentTarget)
    const password = String(fd.get('password') || '')
    const confirm = String(fd.get('confirm') || '')
    try {
      if (password.length < 6) throw new Error('Nova senha com no mínimo 6 caracteres.')
      if (password !== confirm) throw new Error('As senhas não conferem.')
      const { error: upErr } = await supabase.auth.updateUser({
        password,
        data: { must_change_password: false },
      })
      if (upErr) throw upErr
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível alterar a senha.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-shell">
      <form className="auth-card panel" onSubmit={onSubmit}>
        <p className="brand">RifaPIX</p>
        <h2>Trocar senha obrigatória</h2>
        <p className="hint">No primeiro acesso com e-mail, defina uma senha nova só sua.</p>
        {error ? <p className="auth-error">{error}</p> : null}
        <label>
          Nova senha
          <input name="password" type="password" required minLength={6} autoComplete="new-password" />
        </label>
        <label>
          Confirmar nova senha
          <input name="confirm" type="password" required minLength={6} autoComplete="new-password" />
        </label>
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? 'Salvando…' : 'Salvar e entrar'}
        </button>
      </form>
    </div>
  )
}
