import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import {
  getAuthRecord,
  hasPasswordSetup,
  loginAdmin,
  loginAdminSession,
  loginMember,
  loginMemberSession,
  setupPassword,
} from './auth'
import { isSupabaseConfigured, supabase, supabaseConfigError } from './lib/supabase'
import { useAuth } from './lib/useAuth'
import {
  biometricsSupported,
  clearBioUnlock,
  loadBioUnlock,
  registerMemberBiometrics,
  unlockWithBiometrics,
} from './lib/biometrics'
import {
  emptyishState,
  ensureOwnerWorkspace,
  openAsMember,
  peekMembers,
  saveCloudSession,
  saveOwnerWorkspaceState,
} from './lib/workspace'
import { formatErr, translateAuthErr } from './lib/errors'
import { InstallAppButton } from './InstallAppButton'
import { useStore } from './store'

const MEMBER_REMEMBER_KEY = 'rifa-pix-remember-member-v1'
const WORKSPACE_CODE_KEY = 'rifa-pix-workspace-code-v1'
const ADMIN_REMEMBER_KEY = 'rifa-pix-remember-admin-v1'

type RememberedMember = {
  memberId: string
  memberName: string
  pin?: string
  rememberPin: boolean
}

type RememberedAdmin = {
  email: string
  password?: string
  remember: boolean
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

function loadRememberedAdmin(): RememberedAdmin | null {
  try {
    const raw = localStorage.getItem(ADMIN_REMEMBER_KEY)
    return raw ? (JSON.parse(raw) as RememberedAdmin) : null
  } catch {
    return null
  }
}

export function LoginScreen({ onLocalAuthenticated }: Props) {
  const auth = useAuth()
  const members = useStore((s) => s.members)
  const importSnapshot = useStore((s) => s.importSnapshot)
  const exportSnapshot = useStore((s) => s.exportSnapshot)
  const existing = getAuthRecord()
  const isLocalSetup = !hasPasswordSetup()
  const remembered = loadRemembered()
  const rememberedAdmin = loadRememberedAdmin()
  const bio = loadBioUnlock()
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [cloudRole, setCloudRole] = useState<'admin' | 'member'>(remembered || bio ? 'member' : 'admin')
  const [localRole, setLocalRole] = useState<'admin' | 'member'>(remembered ? 'member' : 'admin')
  const [memberId, setMemberId] = useState(remembered?.memberId || bio?.memberId || '')
  const [pin, setPin] = useState(remembered?.rememberPin ? remembered.pin || '' : '')
  const [rememberPin, setRememberPin] = useState<boolean>(Boolean(remembered?.rememberPin) || true)
  const [adminEmail, setAdminEmail] = useState(rememberedAdmin?.email || '')
  const [adminPassword, setAdminPassword] = useState(
    rememberedAdmin?.remember ? rememberedAdmin.password || '' : '',
  )
  const [rememberAdmin, setRememberAdmin] = useState(Boolean(rememberedAdmin?.remember ?? true))
  const [saveInKeychain, setSaveInKeychain] = useState<boolean>(true)
  const [enableFaceId, setEnableFaceId] = useState<boolean>(() => biometricsSupported() && !loadBioUnlock())
  const [workspaceCode, setWorkspaceCode] = useState(() => {
    try {
      const q = new URLSearchParams(window.location.search)
      const fromUrl = (q.get('equipe') || q.get('code') || '').trim().toUpperCase()
      if (fromUrl) {
        localStorage.setItem(WORKSPACE_CODE_KEY, fromUrl)
        // limpa a query da barra (fica o link limpo)
        const url = new URL(window.location.href)
        url.searchParams.delete('equipe')
        url.searchParams.delete('code')
        window.history.replaceState({}, '', url.pathname + url.search + url.hash)
        return fromUrl
      }
    } catch {
      /* ignore */
    }
    return localStorage.getItem(WORKSPACE_CODE_KEY) || bio?.workspaceCode || ''
  })
  const [teamCodeDraft, setTeamCodeDraft] = useState('')
  const [needTeamLink, setNeedTeamLink] = useState(() => !localStorage.getItem(WORKSPACE_CODE_KEY) && !bio?.workspaceCode)
  const [cloudMembers, setCloudMembers] = useState<Array<{ id: string; name: string }>>([])
  const [error, setError] = useState<string | null>(supabaseConfigError)
  const [busy, setBusy] = useState(false)
  const [info, setInfo] = useState<string | null>(null)

  const parseTeamInput = (raw: string) => {
    const text = raw.trim()
    if (!text) return ''
    try {
      if (text.includes('http') || text.includes('equipe=')) {
        const url = new URL(text.startsWith('http') ? text : `https://x.local/${text}`)
        const fromQ = (url.searchParams.get('equipe') || url.searchParams.get('code') || '').trim()
        if (fromQ) return fromQ.toUpperCase()
      }
    } catch {
      /* ignore */
    }
    return text.replace(/[^a-zA-Z0-9]/g, '').toUpperCase()
  }

  const selectedMemberName = useMemo(() => {
    const list = isSupabaseConfigured ? cloudMembers : members.filter((m) => m.active).map((m) => ({ id: m.id, name: m.name }))
    return list.find((m) => m.id === memberId)?.name || remembered?.memberName || bio?.memberName || ''
  }, [cloudMembers, members, memberId, remembered?.memberName, bio?.memberName, isSupabaseConfigured])

  useEffect(() => {
    if (remembered?.memberId && members.some((m) => m.id === remembered.memberId)) {
      setLocalRole('member')
      setMemberId(remembered.memberId)
      if (remembered.rememberPin && remembered.pin) setPin(remembered.pin)
    }
  }, [members, remembered?.memberId, remembered?.pin, remembered?.rememberPin])

  const loadCloudMemberList = async (code: string) => {
    const peek = await peekMembers(code)
    setCloudMembers(peek.members || [])
    localStorage.setItem(WORKSPACE_CODE_KEY, code.trim().toUpperCase())
    setWorkspaceCode(code.trim().toUpperCase())
    setNeedTeamLink(false)
    setInfo(`Equipe pronta · ${peek.members?.length || 0} membros`)
    return peek
  }

  // Com código já salvo (ou ?equipe= no link), busca membros sozinho
  useEffect(() => {
    if (!isSupabaseConfigured || cloudRole !== 'member') return
    if (supabaseConfigError) return
    const code = workspaceCode.trim()
    if (!code || cloudMembers.length) return
    let alive = true
    ;(async () => {
      try {
        const peek = await peekMembers(code)
        if (!alive) return
        setCloudMembers(peek.members || [])
        localStorage.setItem(WORKSPACE_CODE_KEY, code.toUpperCase())
        setNeedTeamLink(false)
        setError(null)
      } catch (err) {
        if (!alive) return
        localStorage.removeItem(WORKSPACE_CODE_KEY)
        setWorkspaceCode('')
        setNeedTeamLink(true)
        setError(
          err instanceof Error
            ? `${err.message} — cole o link novo do ADM abaixo.`
            : 'Equipe inválida. Cole o link do ADM abaixo.',
        )
      }
    })()
    return () => {
      alive = false
    }
  }, [isSupabaseConfigured, cloudRole, workspaceCode, cloudMembers.length])

  const finishMemberLogin = async (code: string, selectedId: string, usedPin: string, memberName: string) => {
    const opened = await openAsMember(code, selectedId, usedPin)
    importSnapshot(opened.state)
    saveCloudSession({
      role: 'member',
      workspace: opened.meta,
      memberId: opened.memberId,
      memberName: opened.memberName || memberName,
    })
    loginMemberSession(opened.memberId, opened.memberName || memberName)
    const payload: RememberedMember = {
      memberId: opened.memberId,
      memberName: opened.memberName || memberName,
      rememberPin: rememberPin || saveInKeychain,
      pin: rememberPin || saveInKeychain ? usedPin : undefined,
    }
    localStorage.setItem(MEMBER_REMEMBER_KEY, JSON.stringify(payload))
    localStorage.setItem(WORKSPACE_CODE_KEY, code.trim().toUpperCase())

    if (enableFaceId && biometricsSupported() && !loadBioUnlock()) {
      try {
        await registerMemberBiometrics({
          workspaceCode: code,
          memberId: opened.memberId,
          memberName: opened.memberName || memberName,
          pin: usedPin,
        })
        setInfo('Face ID / biometria ativados neste aparelho.')
      } catch (err) {
        console.warn(err)
      }
    }

    onLocalAuthenticated()
  }

  const onFaceId = async () => {
    setError(null)
    setInfo(null)
    setBusy(true)
    try {
      const unlocked = await unlockWithBiometrics()
      if (!isSupabaseConfigured || unlocked.workspaceCode === 'LOCAL') {
        const member = useStore.getState().members.find((m) => m.id === unlocked.memberId && m.active)
        if (!member) throw new Error('Membro não encontrado neste aparelho.')
        loginMember(member.id, member.name, unlocked.pin, member.pin)
        onLocalAuthenticated()
        return
      }
      setCloudRole('member')
      setWorkspaceCode(unlocked.workspaceCode)
      setMemberId(unlocked.memberId)
      setPin(unlocked.pin)
      await finishMemberLogin(unlocked.workspaceCode, unlocked.memberId, unlocked.pin, unlocked.memberName)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Falha no Face ID'
      if (/quota/i.test(msg)) {
        setError(
          'Armazenamento do Safari cheio. Em Ajustes → Safari → Avançado → Dados de sites, apague andrerostirolla.github.io e tente de novo.',
        )
      } else {
        setError(msg)
      }
    } finally {
      setBusy(false)
    }
  }

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setError(null)
    setInfo(null)
    setBusy(true)
    const fd = new FormData(e.currentTarget)
    try {
      if (isSupabaseConfigured) {
        if (cloudRole === 'admin') {
          const email = (adminEmail || String(fd.get('email') || '')).trim()
          const password = adminPassword || String(fd.get('password') || '')
          const organizerName = String(fd.get('organizerName') || '')
          if (mode === 'signup') {
            await auth.signUp(email, password, organizerName)
            setInfo('Conta criada. Se o projeto exigir confirmação de e-mail, verifique sua caixa de entrada e entre.')
            return
          }
          await auth.signIn(email, password)
          if (organizerName.trim() && supabase) {
            await supabase.auth.updateUser({
              data: { display_name: organizerName.trim(), organizer_name: organizerName.trim() },
            })
          }
          const { data: sess } = supabase ? await supabase.auth.getUser() : { data: { user: null } }
          const displayName =
            organizerName.trim() ||
            String(sess.user?.user_metadata?.display_name || sess.user?.user_metadata?.organizer_name || '').trim() ||
            email.split('@')[0] ||
            'ADM'
          if (rememberAdmin) {
            localStorage.setItem(
              ADMIN_REMEMBER_KEY,
              JSON.stringify({ email, password, remember: true } satisfies RememberedAdmin),
            )
          } else {
            localStorage.removeItem(ADMIN_REMEMBER_KEY)
          }
          const { meta, state } = await ensureOwnerWorkspace(displayName)
          if (!emptyishState(state)) {
            importSnapshot(state!)
          } else {
            const local = exportSnapshot()
            if (!emptyishState(local)) {
              const updatedAt = await saveOwnerWorkspaceState(meta.id, local)
              meta.updatedAt = updatedAt
            }
          }
          saveCloudSession({ role: 'admin', workspace: meta })
          await loginAdminSession(displayName)
          localStorage.setItem(WORKSPACE_CODE_KEY, meta.accessCode)
          onLocalAuthenticated()
        } else {
          const code = (workspaceCode || localStorage.getItem(WORKSPACE_CODE_KEY) || '').trim()
          if (!code) {
            throw new Error(
              'Abra o link que o ADM enviou (já traz a equipe). Ex.: …/rifa-pix/?equipe=XXXXXX',
            )
          }
          let list = cloudMembers
          if (!list.length) {
            const peek = await loadCloudMemberList(code)
            list = peek.members
          }
          const selectedId = memberId || String(fd.get('memberId') || '')
          const usedPin = pin || String(fd.get('password') || fd.get('pin') || '')
          if (!selectedId) throw new Error('Selecione o membro.')
          if (!usedPin) throw new Error('Informe o PIN.')
          const name = list.find((m) => m.id === selectedId)?.name || selectedMemberName
          await finishMemberLogin(code, selectedId, usedPin, name)
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
        const usedPin = pin || String(fd.get('password') || fd.get('pin') || '')
        loginMember(member.id, member.name, usedPin, member.pin)
        const payload: RememberedMember = {
          memberId: member.id,
          memberName: member.name,
          rememberPin: rememberPin || saveInKeychain,
          pin: rememberPin || saveInKeychain ? usedPin : undefined,
        }
        localStorage.setItem(MEMBER_REMEMBER_KEY, JSON.stringify(payload))
        if (enableFaceId && biometricsSupported() && !loadBioUnlock()) {
          try {
            await registerMemberBiometrics({
              workspaceCode: 'LOCAL',
              memberId: member.id,
              memberName: member.name,
              pin: usedPin,
            })
          } catch {
            /* ignore */
          }
        }
        onLocalAuthenticated()
      }
    } catch (err) {
      const msg = translateAuthErr(formatErr(err))
      if (/quota/i.test(msg)) {
        setError(
          'Armazenamento do Safari cheio. Em Ajustes → Safari → Avançado → Dados de sites, apague andrerostirolla.github.io e tente de novo. (Não dá para limpar isso remotamente.)',
        )
      } else {
        setError(msg)
      }
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

  const memberOptions = isSupabaseConfigured
    ? cloudMembers
    : members.filter((m) => m.active).map((m) => ({ id: m.id, name: m.name }))
  const canFaceId = biometricsSupported() && Boolean(loadBioUnlock())

  return (
    <div className="auth-shell">
      <form className="auth-card panel" onSubmit={onSubmit} autoComplete="on">
        <p className="brand">RifaPIX</p>
        <h1>
          {isSupabaseConfigured
            ? cloudRole === 'member'
              ? 'Entrar como membro'
              : mode === 'signup'
                ? 'Criar conta ADM'
                : 'Entrar ADM'
            : isLocalSetup
              ? 'Criar ADM'
              : 'Entrar'}
        </h1>
        <p className="hint">
          {supabaseConfigError
            ? 'Corrija a chave anon no GitHub Secrets para o login na nuvem funcionar.'
            : isSupabaseConfigured
            ? cloudRole === 'member'
              ? 'Entre com seu nome/PIN. Pode salvar no chaveiro e usar Face ID neste aparelho.'
              : 'ADM usa e-mail e senha (salve no chaveiro do celular para Face ID preencher).'
            : isLocalSetup
              ? 'Primeiro acesso: defina a senha do administrador.'
              : 'ADM vê tudo. Membro vê só seus blocos e vendas.'}
        </p>

        {supabaseConfigError ? <p className="auth-error">{supabaseConfigError}</p> : null}

        {isSupabaseConfigured && (
          <div className="role-switch">
            <button type="button" className={cloudRole === 'admin' ? 'active' : ''} onClick={() => setCloudRole('admin')}>
              Administrador
            </button>
            <button type="button" className={cloudRole === 'member' ? 'active' : ''} onClick={() => setCloudRole('member')}>
              Membro
            </button>
          </div>
        )}

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

        {isSupabaseConfigured && cloudRole === 'admin' ? (
          <>
            {mode === 'signup' && (
              <label>
                Como quer ser chamado no sistema?
                <input
                  name="organizerName"
                  required
                  placeholder="Nome ou apelido"
                  autoComplete="nickname"
                />
              </label>
            )}
            {mode === 'login' && (
              <label>
                Como quer ser chamado neste aparelho? (opcional)
                <input
                  name="organizerName"
                  placeholder="Nome ou apelido"
                  autoComplete="nickname"
                />
              </label>
            )}
            <label>
              E-mail
              <input
                name="email"
                type="email"
                required
                autoComplete="username"
                value={adminEmail}
                onChange={(e) => setAdminEmail(e.target.value)}
              />
            </label>
            <label>
              Senha
              <input
                name="password"
                type="password"
                required
                minLength={6}
                autoComplete="current-password"
                value={adminPassword}
                onChange={(e) => setAdminPassword(e.target.value)}
              />
            </label>
            <label className="check-inline">
              <input
                type="checkbox"
                checked={rememberAdmin}
                onChange={(e) => setRememberAdmin(e.target.checked)}
              />
              Lembrar neste PC
            </label>
            <p className="hint">No iPhone/Android, aceite “Salvar senha” — depois o Face ID preenche sozinho.</p>
          </>
        ) : isSupabaseConfigured && cloudRole === 'member' ? (
          <>
            {canFaceId && (
              <button type="button" className="btn btn-primary" disabled={busy} onClick={onFaceId}>
                Entrar com Face ID / biometria
              </button>
            )}

            {needTeamLink || !workspaceCode.trim() ? (
              <>
                <label>
                  Link ou código da equipe (do ADM)
                  <input
                    value={teamCodeDraft}
                    onChange={(e) => setTeamCodeDraft(e.target.value)}
                    placeholder="Cole o link …?equipe=XXXX ou só o código"
                    autoComplete="off"
                  />
                </label>
                <div className="btn-row">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={busy || !teamCodeDraft.trim() || Boolean(supabaseConfigError)}
                    onClick={async () => {
                      setError(null)
                      setBusy(true)
                      try {
                        const code = parseTeamInput(teamCodeDraft)
                        if (!code) throw new Error('Cole o link completo ou o código.')
                        await loadCloudMemberList(code)
                      } catch (err) {
                        setError(err instanceof Error ? err.message : 'Link/equipe inválidos')
                        setNeedTeamLink(true)
                      } finally {
                        setBusy(false)
                      }
                    }}
                  >
                    Confirmar equipe
                  </button>
                </div>
              </>
            ) : cloudMembers.length === 0 && !error ? (
              <p className="hint">Carregando membros da equipe…</p>
            ) : (
              <p className="hint">
                Equipe ok neste aparelho.{' '}
                <button
                  type="button"
                  className="linkish"
                  onClick={() => {
                    setNeedTeamLink(true)
                    setCloudMembers([])
                  }}
                >
                  Trocar equipe
                </button>
              </p>
            )}

            <label>
              Membro
              <select
                name="memberId"
                required
                value={memberId}
                onChange={(e) => setMemberId(e.target.value)}
                disabled={!workspaceCode.trim() || !cloudMembers.length}
              >
                <option value="" disabled>
                  Selecione
                </option>
                {memberOptions.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>

            {/* Campos pensados para o chaveiro / Face ID do sistema */}
            <label>
              Usuário
              <input
                name="username"
                required
                value={selectedMemberName}
                onChange={() => undefined}
                readOnly
                autoComplete="username"
              />
            </label>
            <label>
              PIN / senha
              <input
                name="password"
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
              <input type="checkbox" checked={saveInKeychain} onChange={(e) => setSaveInKeychain(e.target.checked)} />
              Salvar no chaveiro do celular (Face ID pode preencher depois)
            </label>
            <label className="check-row">
              <input type="checkbox" checked={rememberPin} onChange={(e) => setRememberPin(e.target.checked)} />
              Lembrar PIN neste aparelho
            </label>
            {biometricsSupported() && (
              <label className="check-row">
                <input type="checkbox" checked={enableFaceId} onChange={(e) => setEnableFaceId(e.target.checked)} />
                Ativar botão Face ID / biometria neste aparelho
              </label>
            )}
            {loadBioUnlock() && (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  clearBioUnlock()
                  setInfo('Face ID removido deste aparelho.')
                }}
              >
                Remover Face ID salvo
              </button>
            )}
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
            {canFaceId && (
              <button type="button" className="btn btn-primary" disabled={busy} onClick={onFaceId}>
                Entrar com Face ID / biometria
              </button>
            )}
            <label>
              Membro
              <select name="memberId" required value={memberId} onChange={(e) => setMemberId(e.target.value)}>
                <option value="" disabled>
                  Selecione
                </option>
                {memberOptions.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Usuário
              <input name="username" required value={selectedMemberName} readOnly autoComplete="username" />
            </label>
            <label>
              PIN / senha
              <input
                name="password"
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
              Lembrar PIN neste aparelho
            </label>
            {biometricsSupported() && (
              <label className="check-row">
                <input type="checkbox" checked={enableFaceId} onChange={(e) => setEnableFaceId(e.target.checked)} />
                Ativar Face ID / biometria neste aparelho
              </label>
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
          {isSupabaseConfigured && cloudRole === 'admin' && (
            <button type="button" className="btn btn-secondary" onClick={() => setMode((m) => (m === 'login' ? 'signup' : 'login'))}>
              {mode === 'login' ? 'Criar conta' : 'Já tenho conta'}
            </button>
          )}
          <InstallAppButton />
        </div>
      </form>
    </div>
  )
}
