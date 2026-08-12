import { useState } from 'react'
import type { FormEvent } from 'react'
import { getAuthRecord, hasPasswordSetup, loginAdmin, loginMember, setupPassword } from './auth'
import { isSupabaseConfigured } from './lib/supabase'
import { useAuth } from './lib/useAuth'
import { useStore } from './store'

type Props = {
  onLocalAuthenticated: () => void
}

export function LoginScreen({ onLocalAuthenticated }: Props) {
  const auth = useAuth()
  const members = useStore((s) => s.members)
  const existing = getAuthRecord()
  const isLocalSetup = !hasPasswordSetup()
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [localRole, setLocalRole] = useState<'admin' | 'member'>('admin')
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
      } else if (isLocalSetup) {
        const password = String(fd.get('password') || '')
        const confirm = String(fd.get('confirm') || '')
        const organizerName = String(fd.get('organizerName') || '')
        if (password !== confirm) throw new Error('As senhas não conferem.')
        await setupPassword(organizerName, password)
        onLocalAuthenticated()
      } else if (localRole === 'admin') {
        await loginAdmin(String(fd.get('password') || ''))
        onLocalAuthenticated()
      } else {
        const memberId = String(fd.get('memberId') || '')
        const member = members.find((m) => m.id === memberId && m.active)
        if (!member) throw new Error('Selecione o membro.')
        loginMember(member.id, member.name, String(fd.get('pin') || ''), member.pin)
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
        <h1>{isSupabaseConfigured ? (mode === 'signup' ? 'Criar conta' : 'Entrar') : isLocalSetup ? 'Criar ADM' : 'Entrar'}</h1>
        <p className="hint">
          {isSupabaseConfigured
            ? 'Modo nuvem (Supabase).'
            : isLocalSetup
              ? 'Primeiro acesso: defina a senha do administrador.'
              : 'ADM vê tudo. Membro vê só seus números e vendas.'}
        </p>

        {!isSupabaseConfigured && !isLocalSetup && (
          <div className="role-switch">
            <button type="button" className={localRole === 'admin' ? 'active' : ''} onClick={() => setLocalRole('admin')}>
              Administrador
            </button>
            <button type="button" className={localRole === 'member' ? 'active' : ''} onClick={() => setLocalRole('member')}>
              Membro
            </button>
          </div>
        )}

        {isSupabaseConfigured ? (
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
              <input name="password" type="password" required minLength={6} />
            </label>
          </>
        ) : isLocalSetup ? (
          <>
            <label>
              Nome do administrador
              <input name="organizerName" required placeholder="Seu nome" />
            </label>
            <label>
              Senha ADM
              <input name="password" type="password" required minLength={4} />
            </label>
            <label>
              Confirmar senha
              <input name="confirm" type="password" required minLength={4} />
            </label>
          </>
        ) : localRole === 'admin' ? (
          <label>
            Senha ADM
            <input name="password" type="password" required minLength={4} autoComplete="current-password" />
          </label>
        ) : (
          <>
            <label>
              Membro
              <select name="memberId" required defaultValue="">
                <option value="" disabled>
                  Selecione
                </option>
                {members
                  .filter((m) => m.active)
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              PIN
              <input name="pin" type="password" inputMode="numeric" required minLength={4} placeholder="PIN do membro" />
            </label>
            {!members.filter((m) => m.active).length && (
              <p className="hint">Nenhum membro cadastrado. Entre como ADM e cadastre na aba Equipe.</p>
            )}
          </>
        )}

        {error && <p className="auth-error">{error}</p>}
        {info && <p className="hint">{info}</p>}
        {!isSupabaseConfigured && !isLocalSetup && localRole === 'admin' && existing && (
          <p className="hint">Olá, {existing.organizerName}.</p>
        )}

        <div className="btn-row">
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {busy ? 'Aguarde…' : 'Entrar'}
          </button>
          {isSupabaseConfigured && (
            <button type="button" className="btn btn-secondary" onClick={() => setMode((m) => (m === 'login' ? 'signup' : 'login'))}>
              {mode === 'login' ? 'Criar conta' : 'Já tenho conta'}
            </button>
          )}
        </div>
      </form>
    </div>
  )
}
