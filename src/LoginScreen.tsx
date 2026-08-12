import { useState } from 'react'
import type { FormEvent } from 'react'
import { getAuthRecord, hasPasswordSetup, login, setupPassword } from './auth'

type Props = {
  onAuthenticated: () => void
}

export function LoginScreen({ onAuthenticated }: Props) {
  const existing = getAuthRecord()
  const isSetup = !hasPasswordSetup()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setError(null)
    setBusy(true)
    const fd = new FormData(e.currentTarget)
    const password = String(fd.get('password') || '')
    const organizerName = String(fd.get('organizerName') || '')
    try {
      if (isSetup) {
        const confirm = String(fd.get('confirm') || '')
        if (password !== confirm) throw new Error('As senhas não conferem.')
        await setupPassword(organizerName, password)
      } else {
        await login(password)
      }
      onAuthenticated()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha na autenticação.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-shell">
      <form className="auth-card panel" onSubmit={onSubmit}>
        <p className="brand">RifaPIX</p>
        <h1>{isSetup ? 'Criar acesso' : 'Entrar'}</h1>
        <p className="hint">
          {isSetup
            ? 'Defina a senha do organizador para proteger vendas e PIX neste aparelho/navegador.'
            : `Olá, ${existing?.organizerName || 'organizador'}. Digite a senha para continuar.`}
        </p>

        {isSetup && (
          <label>
            Nome do organizador
            <input name="organizerName" required placeholder="Seu nome" autoComplete="username" />
          </label>
        )}

        <label>
          Senha
          <input name="password" type="password" required minLength={4} autoComplete={isSetup ? 'new-password' : 'current-password'} />
        </label>

        {isSetup && (
          <label>
            Confirmar senha
            <input name="confirm" type="password" required minLength={4} autoComplete="new-password" />
          </label>
        )}

        {error && <p className="auth-error">{error}</p>}

        <div className="btn-row">
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {busy ? 'Aguarde…' : isSetup ? 'Criar e entrar' : 'Entrar'}
          </button>
        </div>
      </form>
    </div>
  )
}
