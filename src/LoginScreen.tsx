import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { getAuthRecord, hasPasswordSetup, loginAdmin, loginMember, setupPassword } from './auth'
import { isSupabaseConfigured } from './lib/supabase'
import { useAuth } from './lib/useAuth'
import { useStore } from './store'

const MEMBER_REMEMBER_KEY = 'rifa-pix-remember-member-v1'

type RememberedMember = {
  memberId: string
  memberName: string
  pin?: string
  rememberPin: boolean
}

type Props = {
  onLocalAuthenticated: () => void
}

function loadRemembered(): RememberedMember | null {
  try {
    const raw = localStorage.getItem(MEMBER_REMEMBER_KEY)
    return raw ? (JSON.parse(raw) as RememberedMember) : null
  } catch {
    return null
  }
}

export function LoginScreen({ onLocalAuthenticated }: Props) {
  const auth = useAuth()
  const members = useStore((s) => s.members)
  const existing = getAuthRecord()
  const isLocalSetup = !hasPasswordSetup()
  const remembered = loadRemembered()
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [localRole, setLocalRole] = useState<'admin' | 'member'>(remembered ? 'member' : 'admin')
  const [memberId, setMemberId] = useState(remembered?.memberId || '')
  const [pin, setPin] = useState(remembered?.rememberPin ? remembered.pin || '' : '')
  const [rememberPin, setRememberPin] = useState(Boolean(remembered?.rememberPin))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [info, setInfo] = useState<string | null>(null)

  useEffect(() => {
    if (remembered?.memberId && members.some((m) => m.id === remembered.memberId)) {
      setLocalRole('member')
      setMemberId(remembered.memberId)
      if (remembered.rememberPin && remembered.pin) setPin(remembered.pin)
    }
  }, [members, remembered?.memberId, remembered?.pin, remembered?.rememberPin])

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
        const selectedId = memberId || String(fd.get('memberId') || '')
        const member = members.find((m) => m.id === selectedId && m.active)
        if (!member) throw new Error('Selecione o membro.')
        const usedPin = pin || String(fd.get('pin') || '')
        loginMember(member.id, member.name, usedPin, member.pin)
        const payload: RememberedMember = {
          memberId: member.id,
          memberName: member.name,
          rememberPin,
          pin: rememberPin ? usedPin : undefined,
        }
        localStorage.setItem(MEMBER_REMEMBER_KEY, JSON.stringify(payload))
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
      <form className="auth-card panel" onSubmit={onSubmit} autoComplete="on">
        <p className="brand">RifaPIX</p>
        <h1>{isSupabaseConfigured ? (mode === 'signup' ? 'Criar conta' : 'Entrar') : isLocalSetup ? 'Criar ADM' : 'Entrar'}</h1>
        <p className="hint">
          {isSupabaseConfigured
            ? 'Modo nuvem (Supabase).'
            : isLocalSetup
              ? 'Primeiro acesso: defina a senha do administrador.'
              : 'ADM vê tudo. Membro vê só seus blocos e vendas.'}
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
              <input name="email" type="email" required autoComplete="username" />
            </label>
            <label>
              Senha
              <input name="password" type="password" required minLength={6} autoComplete="current-password" />
            </label>
          </>
        ) : isLocalSetup ? (
          <>
            <label>
              Nome do administrador
              <input name="organizerName" required placeholder="Seu nome" autoComplete="username" />
            </label>
            <label>
              Senha ADM
              <input name="password" type="password" required minLength={4} autoComplete="new-password" />
            </label>
            <label>
              Confirmar senha
              <input name="confirm" type="password" required minLength={4} autoComplete="new-password" />
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
              <select
                name="memberId"
                required
                value={memberId}
                onChange={(e) => setMemberId(e.target.value)}
                autoComplete="username"
              >
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
            {remembered?.memberName && memberId === remembered.memberId && (
              <p className="hint">Último acesso: <strong>{remembered.memberName}</strong></p>
            )}
            <label>
              PIN
              <input
                name="pin"
                type="password"
                inputMode="numeric"
                required
                minLength={4}
                placeholder="PIN do membro"
                value={pin}
                onChange={(e) => setPin(e.target.value)}
                autoComplete="current-password"
              />
            </label>
            <label className="check-row">
              <input type="checkbox" checked={rememberPin} onChange={(e) => setRememberPin(e.target.checked)} />
              Lembrar PIN neste aparelho (Face ID / chaveiro do celular pode preencher também)
            </label>
            <p className="hint">
              No iPhone/Android, aceite salvar a senha no navegador para desbloquear com Face ID / biometria.
            </p>
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
