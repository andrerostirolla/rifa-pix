import { useState } from 'react'
import type { FormEvent } from 'react'
import { getAuthRecord, hasPasswordSetup, login, setupPassword } from './auth'
import { isSupabaseConfigured } from './lib/supabase'
import { useAuth } from './lib/useAuth'

type Props = {
  onLocalAuthenticated: () => void
}

export function LoginScreen({ onLocalAuthenticated }: Props) {
  const auth = useAuth()
  const existing = getAuthRecord()
  const isLocalSetup = !hasPasswordSetup()
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [info, setInfo] = useState<string | null>(null)

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setError(null)
    setInfo(null)
    setBusy(true)
    const fd = new FormData(e.currentTarget)
    try {
      if (isSupabaseConfigured) {
        const email = String(fd.get('email') || '').trim()
        const password = String(fd.get('password') || '')
        const organizerName = String(fd.get('organizerName') || '')
        if (mode === 'signup') {
          await auth.signUp(email, password, organizerName)
          setInfo('Conta criada. Se o projeto exigir confirmação de e-mail, verifique sua caixa de entrada.')
        } else {
          await auth.signIn(email, password)
        }
      } else {
        const password = String(fd.get('password') || '')
        const organizerName = String(fd.get('organizerName') || '')
        if (isLocalSetup) {
          const confirm = String(fd.get('confirm') || '')
          if (password !== confirm) throw new Error('As senhas não conferem.')
          await setupPassword(organizerName, password)
        } else {
          await login(password)
        }
        onLocalAuthenticated()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha na autenticação.')
    } finally {
      setBusy(false)
    }
  }

  if (auth.configured && auth.loading) {
    return (
      <div className="auth-shell">
        <div className="auth-card panel">
          <p className="brand">RifaPIX</p>
          <p className="hint">Carregando sessão…</p>
        </div>
      </div>
    )
  }

  return (
    <div className="auth-shell">
      <form className="auth-card panel" onSubmit={onSubmit}>
        <p className="brand">RifaPIX</p>
        <h1>{auth.configured ? (mode === 'signup' ? 'Criar conta' : 'Entrar') : isLocalSetup ? 'Criar acesso' : 'Entrar'}</h1>
        <p className="hint">
          {auth.configured
            ? 'Modo nuvem: dados no Postgres (Supabase) com baixa automática de PIX via webhook.'
            : isLocalSetup
              ? 'Modo local: defina a senha do organizador neste navegador. Configure o Supabase para banco na nuvem.'
              : `Olá, ${existing?.organizerName || 'organizador'}. Digite a senha local para continuar.`}
        </p>

        {auth.configured ? (
          <>
            {mode === 'signup' && (
              <label>
                Nome do organizador
                <input name="organizerName" required placeholder="Seu nome" />
              </label>
            )}
            <label>
              E-mail
              <input name="email" type="email" required autoComplete="email" />
            </label>
            <label>
              Senha
              <input name="password" type="password" required minLength={6} autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} />
            </label>
          </>
        ) : (
          <>
            {isLocalSetup && (
              <label>
                Nome do organizador
                <input name="organizerName" required placeholder="Seu nome" autoComplete="username" />
              </label>
            )}
            <label>
              Senha
              <input name="password" type="password" required minLength={4} autoComplete={isLocalSetup ? 'new-password' : 'current-password'} />
            </label>
            {isLocalSetup && (
              <label>
                Confirmar senha
                <input name="confirm" type="password" required minLength={4} autoComplete="new-password" />
              </label>
            )}
          </>
        )}

        {error && <p className="auth-error">{error}</p>}
        {info && <p className="hint">{info}</p>}

        <div className="btn-row">
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {busy ? 'Aguarde…' : auth.configured ? (mode === 'signup' ? 'Criar conta' : 'Entrar') : isLocalSetup ? 'Criar e entrar' : 'Entrar'}
          </button>
          {auth.configured && (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                setMode((m) => (m === 'login' ? 'signup' : 'login'))
                setError(null)
                setInfo(null)
              }}
            >
              {mode === 'login' ? 'Criar conta' : 'Já tenho conta'}
            </button>
          )}
        </div>
      </form>
    </div>
  )
}
