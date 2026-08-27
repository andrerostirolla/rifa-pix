import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { AppUpdateBanner } from './AppUpdateBanner'
import { CloudRequiredBanner } from './CloudRequiredBanner'
import { loginAdminSession, loginMemberSession } from './auth'
import { CloudSyncContext } from './lib/cloudSyncContext'
import { supabase } from './lib/supabase'
import {
  emptyishState,
  ensureOwnerWorkspace,
  fetchByAccessCode,
  fetchOwnerWorkspace,
  loadCloudSession,
  peekWorkspaceUpdatedAt,
  saveByAccessCode,
  saveCloudSession,
  saveOwnerWorkspaceState,
  type CloudSession,
} from './lib/workspace'
import { offloadEmbeddedProofs } from './lib/proofs'
import { formatErr, isNetworkError, translateAuthErr } from './lib/errors'
import { useStore } from './store'
import type { AppState } from './types'

type Props = {
  mode: 'admin' | 'member'
  onReady: () => void
  onError: (msg: string) => void
  children: ReactNode
}

type SyncStatus = 'sincronizado' | 'salvando' | 'baixando' | 'offline'

const PUSH_DEBOUNCE_MS = 200
const PULL_INTERVAL_MS = 1200
/** Em contingência (sem rede): tenta de novo a cada 30s, sem piscar a tela. */
const CONTINGENCY_RETRY_MS = 30_000
/** App em segundo plano: testa a rede a cada 1 min e sincroniza sozinho. */
const BACKGROUND_RETRY_MS = 60_000
/** Sem resposta da nuvem: derruba a chamada para o app não ficar preso em "salvando". */
const NET_TIMEOUT_MS = 15_000
/** Folga de relógio entre aparelhos ao decidir o que ainda não subiu. */
const CLOCK_SKEW_MS = 5_000
/** Tempo máximo que um cadeado de sync pode ficar preso antes de ser liberado à força. */
const LOCK_MAX_MS = 50_000

function withTimeout<T>(promise: Promise<T>, what: string, ms = NET_TIMEOUT_MS): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      window.setTimeout(() => reject(new Error(`Sem resposta da nuvem ao ${what}.`)), ms),
    ),
  ])
}

function snapshotFromStore(): AppState {
  const s = useStore.getState()
  return {
    raffles: s.raffles,
    members: s.members,
    blocks: s.blocks,
    numberRanges: s.numberRanges,
    sales: s.sales,
    pixPayments: s.pixPayments,
    amortizations: s.amortizations,
    pixCharges: s.pixCharges,
    memberSettlements: s.memberSettlements,
    blockTransfers: s.blockTransfers,
    auditLog: s.auditLog,
  }
}

function isNewer(remoteIso: string, localIso: string) {
  if (!remoteIso) return false
  if (!localIso) return true
  return new Date(remoteIso).getTime() > new Date(localIso).getTime() + 20
}

/** Une vendas locais (contingência) com o que já está na nuvem, sem apagar nenhum lado. */
function mergeContingencyState(remote: AppState, local: AppState): AppState {
  const salesById = new Map((remote.sales || []).map((s) => [s.id, s]))
  for (const s of local.sales || []) {
    if (!salesById.has(s.id)) salesById.set(s.id, s)
  }
  const chargesById = new Map((remote.pixCharges || []).map((c) => [c.id, c]))
  for (const c of local.pixCharges || []) {
    if (!chargesById.has(c.id)) chargesById.set(c.id, c)
  }
  const auditRemote = remote.auditLog || []
  const auditLocal = local.auditLog || []
  const auditIds = new Set(auditRemote.map((a) => a.id))
  const auditMerged = [...auditRemote, ...auditLocal.filter((a) => !auditIds.has(a.id))]
  return {
    ...remote,
    sales: [...salesById.values()],
    pixCharges: [...chargesById.values()],
    auditLog: auditMerged.slice(0, 500),
  }
}

/**
 * Vendas feitas neste aparelho depois do último sync (contingência) não podem ser
 * apagadas por um pull: elas ainda não existem na nuvem e seriam perdidas.
 */
function carryUnsyncedLocal(
  remote: AppState,
  local: AppState,
  syncedAtIso: string,
): { state: AppState; carried: number } {
  const cut = syncedAtIso ? new Date(syncedAtIso).getTime() - CLOCK_SKEW_MS : NaN
  if (!Number.isFinite(cut)) return { state: remote, carried: 0 }

  const remoteSales = new Set((remote.sales || []).map((s) => s.id))
  const pending = (local.sales || []).filter(
    (s) => !remoteSales.has(s.id) && new Date(s.createdAt).getTime() > cut,
  )
  if (!pending.length) return { state: remote, carried: 0 }

  const pendingSaleIds = new Set(pending.map((s) => s.id))
  const remoteCharges = new Set((remote.pixCharges || []).map((c) => c.id))
  const charges = (local.pixCharges || []).filter(
    (c) => !remoteCharges.has(c.id) && c.saleId && pendingSaleIds.has(c.saleId),
  )

  return {
    state: {
      ...remote,
      sales: [...(remote.sales || []), ...pending],
      pixCharges: [...(remote.pixCharges || []), ...charges],
    },
    carried: pending.length,
  }
}

function syncChannelName(accessCode: string) {
  return `rifa-sync-${accessCode.trim().toUpperCase()}`
}

/** Hidrata o zustand, salva rápido, broadcast + poll curto entre aparelhos. */
export function CloudWorkspaceBridge({ mode, onReady, onError, children }: Props) {
  const [boot, setBoot] = useState(true)
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('baixando')
  const [syncError, setSyncError] = useState<string | null>(null)
  const sessionRef = useRef<CloudSession | null>(loadCloudSession())
  const updatedAtRef = useRef(sessionRef.current?.workspace.updatedAt || '')
  const savingRef = useRef(false)
  const savingSinceRef = useRef(0)
  const pullingRef = useRef(false)
  const pullingSinceRef = useRef(0)
  const applyingRemoteRef = useRef(false)
  const dirtyRef = useRef(false)
  const pushTimerRef = useRef<number | null>(null)
  const skipPullUntilRef = useRef(0)
  const channelRef = useRef<ReturnType<NonNullable<typeof supabase>['channel']> | null>(null)
  const syncStatusRef = useRef<SyncStatus>('baixando')
  const quietRetryRef = useRef(false)

  const setStatus = (next: SyncStatus) => {
    syncStatusRef.current = next
    setSyncStatus(next)
  }

  const applyRemote = (state: AppState, updatedAt: string, meta?: Partial<CloudSession['workspace']>) => {
    const { state: merged, carried } = carryUnsyncedLocal(state, snapshotFromStore(), updatedAtRef.current)
    applyingRemoteRef.current = true
    // Se sobrou venda de contingência para subir, o aparelho continua "sujo"
    dirtyRef.current = carried > 0
    useStore.getState().importSnapshot(merged)
    updatedAtRef.current = updatedAt
    const session = sessionRef.current
    if (session) {
      session.workspace = { ...session.workspace, ...meta, updatedAt }
      saveCloudSession(session)
      sessionRef.current = session
    }
    window.setTimeout(() => {
      applyingRemoteRef.current = false
      if (carried > 0) void pushNow()
    }, 400)
  }

  const broadcastUpdated = async (updatedAt: string) => {
    const session = sessionRef.current
    if (!session || !supabase || !channelRef.current) return
    try {
      await channelRef.current.send({
        type: 'broadcast',
        event: 'workspace_updated',
        payload: {
          updatedAt,
          workspaceId: session.workspace.id,
          from: session.role,
        },
      })
    } catch (err) {
      console.warn('Broadcast sync falhou', err)
    }
  }

  const migrateProofsIfNeeded = async (state: AppState): Promise<{ state: AppState; moved: number }> => {
    try {
      const { state: next, moved, errors } = await offloadEmbeddedProofs(state, sessionRef.current?.workspace.id)
      if (errors.length) console.warn('Migração de comprovantes:', errors)
      if (moved <= 0) return { state, moved: 0 }
      applyingRemoteRef.current = true
      useStore.getState().importSnapshot(next)
      window.setTimeout(() => {
        applyingRemoteRef.current = false
      }, 0)
      return { state: next, moved }
    } catch (err) {
      console.warn('Falha ao migrar comprovantes para Storage', err)
      return { state, moved: 0 }
    }
  }

  const pushNow = async () => {
    const session = sessionRef.current || loadCloudSession()
    if (!session || savingRef.current || applyingRemoteRef.current) return
    savingRef.current = true
    savingSinceRef.current = Date.now()
    dirtyRef.current = false
    if (!quietRetryRef.current) setStatus('salvando')
    try {
      let { state } = await migrateProofsIfNeeded(snapshotFromStore())
      let updatedAt: string
      try {
        // withTimeout: sem rede o fetch pode ficar pendurado e travar o sync inteiro
        if (session.role === 'admin') {
          if (!session.workspace.id) throw new Error('Workspace sem id')
          const opened = await withTimeout(
            fetchOwnerWorkspace(session.workspace.id, session.workspace.accessCode),
            'ler o workspace',
          )
          if (isNewer(opened.meta.updatedAt, updatedAtRef.current)) {
            state = mergeContingencyState(opened.state, state)
            applyingRemoteRef.current = true
            useStore.getState().importSnapshot(state)
            window.setTimeout(() => {
              applyingRemoteRef.current = false
            }, 0)
          }
          updatedAt = await withTimeout(
            saveOwnerWorkspaceState(session.workspace.id, state, session.workspace.accessCode),
            'salvar',
          )
        } else {
          updatedAt = await withTimeout(
            saveByAccessCode(session.workspace.accessCode, state, updatedAtRef.current),
            'salvar',
          )
        }
      } catch (firstErr) {
        const msg = firstErr instanceof Error ? firstErr.message : String(firstErr)
        if (!/desatualiz|conflict|updated/i.test(msg)) throw firstErr
        // Nuvem mudou enquanto estava offline: mescla vendas locais e sobe de novo
        const opened = await withTimeout(
          session.role === 'admin' && session.workspace.id
            ? fetchOwnerWorkspace(session.workspace.id, session.workspace.accessCode)
            : fetchByAccessCode(session.workspace.accessCode),
          'ler o workspace',
        )
        state = mergeContingencyState(opened.state, snapshotFromStore())
        applyingRemoteRef.current = true
        useStore.getState().importSnapshot(state)
        window.setTimeout(() => {
          applyingRemoteRef.current = false
        }, 0)
        if (session.role === 'admin' && session.workspace.id) {
          updatedAt = await withTimeout(
            saveOwnerWorkspaceState(session.workspace.id, state, session.workspace.accessCode),
            'salvar',
          )
        } else {
          updatedAt = await withTimeout(
            saveByAccessCode(session.workspace.accessCode, state, opened.meta.updatedAt),
            'salvar',
          )
        }
      }
      updatedAtRef.current = updatedAt
      session.workspace.updatedAt = updatedAt
      saveCloudSession(session)
      sessionRef.current = session
      skipPullUntilRef.current = Date.now() + 350
      setStatus('sincronizado')
      setSyncError(null)
      void broadcastUpdated(updatedAt)
    } catch (err) {
      const msg = formatErr(err, 'Falha ao salvar')
      console.warn('Falha ao salvar na nuvem', err)
      if (session.role === 'admin') {
        try {
          dirtyRef.current = false
          pullingRef.current = false
          await pullNow(true)
          return
        } catch (pullErr) {
          console.warn('Recuperação por pull após falha ao salvar (ADM)', pullErr)
        }
      }
      setStatus('offline')
      setSyncError(msg)
      dirtyRef.current = true
    } finally {
      savingRef.current = false
      savingSinceRef.current = 0
    }
  }

  const pullNow = async (force = false) => {
    const session = sessionRef.current || loadCloudSession()
    if (!session || pullingRef.current || savingRef.current) return
    if (!force && Date.now() < skipPullUntilRef.current) return

    // Contingência offline (membro): sobe o local sujo antes de baixar.
    // ADM acompanhando vendas: se a nuvem já mudou, só baixa (evita "falha ao salvar" por conflito).
    if (dirtyRef.current) {
      if (session.role === 'admin') {
        try {
          const remoteTs = await withTimeout(
            peekWorkspaceUpdatedAt(session.workspace.accessCode),
            'consultar a nuvem',
          )
          if (isNewer(remoteTs, updatedAtRef.current)) {
            dirtyRef.current = false
          } else {
            await pushNow()
            if (dirtyRef.current) return
            if (!force) return
          }
        } catch {
          await pushNow()
          if (dirtyRef.current) return
          if (!force) return
        }
      } else {
        await pushNow()
        if (dirtyRef.current) return
        if (!force) return
      }
    }

    pullingRef.current = true
    pullingSinceRef.current = Date.now()
    try {
      // checagem barata primeiro (se RPC existir); senão cai no fetch completo
      try {
        const remoteTs = await withTimeout(
          peekWorkspaceUpdatedAt(session.workspace.accessCode),
          'consultar a nuvem',
        )
        if (!force && !isNewer(remoteTs, updatedAtRef.current)) {
          setStatus('sincronizado')
          setSyncError(null)
          return
        }
      } catch (peekErr) {
        if (!navigator.onLine || quietRetryRef.current) throw peekErr
      }

      if (!quietRetryRef.current) setStatus('baixando')
      const opened = await withTimeout(
        session.role === 'admin' && session.workspace.id
          ? fetchOwnerWorkspace(session.workspace.id, session.workspace.accessCode)
          : fetchByAccessCode(session.workspace.accessCode),
        'baixar',
      )
      if (force || isNewer(opened.meta.updatedAt, updatedAtRef.current)) {
        if (!quietRetryRef.current) setStatus('baixando')
        applyRemote(opened.state, opened.meta.updatedAt, opened.meta)
        setStatus('sincronizado')
        setSyncError(null)
      } else {
        setStatus('sincronizado')
        setSyncError(null)
      }
    } catch (err) {
      const msg = formatErr(err, 'Falha ao baixar')
      console.warn('Falha ao puxar da nuvem', err)
      setSyncError(msg)
      // Já tem workspace em memória e a rede está de pé: não dispara contingência por um pull falho
      if (updatedAtRef.current && navigator.onLine && !quietRetryRef.current) {
        setStatus('sincronizado')
      } else {
        setStatus('offline')
      }
    } finally {
      pullingRef.current = false
      pullingSinceRef.current = 0
    }
  }

  /** Se uma chamada morreu pendurada, o cadeado ficaria preso e nada mais sincronizaria. */
  const clearStuckLocks = () => {
    const now = Date.now()
    if (savingRef.current && savingSinceRef.current && now - savingSinceRef.current > LOCK_MAX_MS) {
      console.warn('Sync preso ao salvar — liberando para tentar de novo')
      savingRef.current = false
      savingSinceRef.current = 0
      dirtyRef.current = true
    }
    if (pullingRef.current && pullingSinceRef.current && now - pullingSinceRef.current > LOCK_MAX_MS) {
      console.warn('Sync preso ao baixar — liberando para tentar de novo')
      pullingRef.current = false
      pullingSinceRef.current = 0
    }
  }

  /** Rede de volta (ou app em foco): sobe o pendente e baixa, sem recarregar a página. */
  const reconnectNow = async (quiet = false) => {
    quietRetryRef.current = quiet
    clearStuckLocks()
    try {
      if (dirtyRef.current) await pushNow()
      await pullNow(true)
    } finally {
      quietRetryRef.current = false
    }
  }

  useEffect(() => {
    let alive = true
    const BOOT_MS = 20_000
    ;(async () => {
      try {
        const session = loadCloudSession()
        sessionRef.current = session
        if (!session) {
          if (alive) {
            setBoot(false)
            onError('Sessão nuvem ausente. Entre de novo.')
          }
          return
        }

        const enterMemberOffline = (reason: string) => {
          if (!session || session.role !== 'member') return false
          loginMemberSession(session.memberId, session.memberName)
          dirtyRef.current = true
          setBoot(false)
          setStatus('offline')
          setSyncError(reason)
          onReady()
          return true
        }

        if (mode === 'member' && session.role === 'member' && !navigator.onLine) {
          enterMemberOffline('Sem internet neste aparelho.')
          return
        }

        const bootWork = async () => {
          if (mode === 'admin' && session.role === 'admin') {
            const { meta, state } = await ensureOwnerWorkspace(session.workspace.name)
            const next: CloudSession = { role: 'admin', workspace: meta }
            saveCloudSession(next)
            sessionRef.current = next
            if (!emptyishState(state)) {
              // updatedAtRef só depois: applyRemote usa o valor antigo para saber o que ainda não subiu
              applyRemote(state!, meta.updatedAt, meta)
            } else {
              updatedAtRef.current = meta.updatedAt
              const local = snapshotFromStore()
              if (!emptyishState(local)) {
                const updatedAt = await saveOwnerWorkspaceState(meta.id, local, meta.accessCode)
                updatedAtRef.current = updatedAt
                next.workspace.updatedAt = updatedAt
                saveCloudSession(next)
              }
            }
            // Nome da pessoa, não da equipe: é o que aparece no rastro de ações
            let admName = ''
            try {
              const { data } = (await supabase?.auth.getUser()) || { data: { user: null } }
              const meta2 = data.user?.user_metadata as { organizer_name?: string } | undefined
              admName = meta2?.organizer_name?.trim() || data.user?.email?.split('@')[0] || ''
            } catch {
              /* segue com o nome da equipe */
            }
            await loginAdminSession(admName || meta.name || 'ADM')
          } else if (mode === 'member' && session.role === 'member') {
            const opened = await fetchByAccessCode(session.workspace.accessCode)
            const next: CloudSession = {
              role: 'member',
              workspace: opened.meta,
              memberId: session.memberId,
              memberName: session.memberName,
            }
            saveCloudSession(next)
            sessionRef.current = next
            applyRemote(opened.state, opened.meta.updatedAt, opened.meta)
            loginMemberSession(session.memberId, session.memberName)
          } else {
            throw new Error('Sessão inválida para este modo.')
          }

          // Migração de comprovantes não pode travar a entrada
          try {
            const { moved } = await Promise.race([
              migrateProofsIfNeeded(snapshotFromStore()),
              new Promise<{ moved: number }>((resolve) =>
                window.setTimeout(() => resolve({ moved: 0 }), 8_000),
              ),
            ])
            if (moved > 0) {
              dirtyRef.current = true
              await pushNow()
            }
          } catch (migErr) {
            console.warn('Migração de comprovantes ignorada no boot', migErr)
          }
        }

        await Promise.race([
          bootWork(),
          new Promise((_, reject) =>
            window.setTimeout(
              () => reject(new Error('Tempo esgotado ao sincronizar. Verifique a internet e tente de novo.')),
              BOOT_MS,
            ),
          ),
        ])

        if (alive) {
          setBoot(false)
          setStatus('sincronizado')
          onReady()
        }
      } catch (err) {
        if (!alive) return
        const msg = translateAuthErr(formatErr(err, 'Falha ao abrir workspace'))
        const session = sessionRef.current

        if (mode === 'member' && session?.role === 'member' && isNetworkError(err)) {
          loginMemberSession(session.memberId, session.memberName)
          dirtyRef.current = true
          setBoot(false)
          setStatus('offline')
          setSyncError(msg)
          onReady()
          return
        }

        setBoot(false)
        setStatus('offline')
        onError(msg)
      }
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, onError, onReady])

  // Push explícito (ADM cadastra equipe/evento etc.)
  useEffect(() => {
    if (boot) return
    const onPush = () => {
      dirtyRef.current = true
      void pushNow()
    }
    window.addEventListener('rifa-request-cloud-push', onPush)
    return () => window.removeEventListener('rifa-request-cloud-push', onPush)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boot])

  // Push local → nuvem (membro vende; ADM só recebe via pull)
  useEffect(() => {
    if (boot) return
    const unsub = useStore.subscribe(() => {
      if (applyingRemoteRef.current) return
      if (mode === 'admin') return
      dirtyRef.current = true
      if (syncStatusRef.current === 'offline' || !navigator.onLine) return
      setStatus('salvando')
      if (pushTimerRef.current) window.clearTimeout(pushTimerRef.current)
      pushTimerRef.current = window.setTimeout(() => {
        void pushNow()
      }, PUSH_DEBOUNCE_MS)
    })
    return () => {
      unsub()
      if (pushTimerRef.current) window.clearTimeout(pushTimerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boot, mode])

  // Sessão atualizada fora do bridge (ex.: após criar/baixar PIX no servidor)
  useEffect(() => {
    if (boot) return
    const onSession = (ev: Event) => {
      const detail = (ev as CustomEvent<CloudSession | null>).detail
      if (!detail) return
      sessionRef.current = detail
      if (detail.workspace.updatedAt) {
        updatedAtRef.current = detail.workspace.updatedAt
        skipPullUntilRef.current = Date.now() + 800
      }
    }
    window.addEventListener('rifa-cloud-session', onSession)
    return () => window.removeEventListener('rifa-cloud-session', onSession)
  }, [boot])

  // Pull periódico: 1,2s online; 30s em contingência; 1 min em segundo plano
  useEffect(() => {
    if (boot) return
    let timer = 0
    const delayNow = () => {
      if (document.visibilityState !== 'visible') return BACKGROUND_RETRY_MS
      if (syncStatusRef.current === 'offline' || !navigator.onLine) return CONTINGENCY_RETRY_MS
      return PULL_INTERVAL_MS
    }
    const tick = () => {
      const offline = syncStatusRef.current === 'offline' || !navigator.onLine
      const hidden = document.visibilityState !== 'visible'
      if (offline || hidden) {
        void reconnectNow(true)
      } else {
        void pullNow(false)
      }
      timer = window.setTimeout(tick, delayNow())
    }
    timer = window.setTimeout(tick, delayNow())
    const onFocus = () => {
      void reconnectNow(syncStatusRef.current === 'offline')
    }
    const onOnline = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(tick, 400)
    }
    const onOffline = () => {
      setStatus('offline')
      setSyncError('Sem internet neste aparelho.')
      window.clearTimeout(timer)
      timer = window.setTimeout(tick, CONTINGENCY_RETRY_MS)
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void reconnectNow(syncStatusRef.current === 'offline')
      }
    }
    window.addEventListener('focus', onFocus)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
      document.removeEventListener('visibilitychange', onVisibility)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boot])

  // Broadcast entre todos os aparelhos do mesmo código + realtime ADM
  useEffect(() => {
    if (boot) return
    const sb = supabase
    if (!sb) return
    const session = sessionRef.current
    if (!session?.workspace.accessCode) return

    const channel = sb.channel(syncChannelName(session.workspace.accessCode), {
      config: { broadcast: { self: false } },
    })
    channelRef.current = channel

    channel.on('broadcast', { event: 'workspace_updated' }, (payload) => {
      const updatedAt = String((payload.payload as { updatedAt?: string } | undefined)?.updatedAt || '')
      if (updatedAt && !isNewer(updatedAt, updatedAtRef.current)) return
      if (session.role === 'admin') {
        if (savingRef.current) return
        dirtyRef.current = false
        void pullNow(true)
        return
      }
      if (dirtyRef.current || savingRef.current) {
        void pushNow().then(() => pullNow(true))
        return
      }
      void pullNow(true)
    })

    if (session.role === 'admin' && session.workspace.id) {
      channel.on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'workspaces',
          filter: `id=eq.${session.workspace.id}`,
        },
        (payload) => {
          const row = payload.new as {
            state?: AppState
            updated_at?: string
            access_code?: string
            name?: string
          }
          if (!row?.updated_at || !row.state) return
          if (!isNewer(row.updated_at, updatedAtRef.current)) return
          if (savingRef.current) return
          dirtyRef.current = false
          setStatus('baixando')
          applyRemote(row.state, row.updated_at, {
            updatedAt: row.updated_at,
            accessCode: row.access_code || session.workspace.accessCode,
            name: row.name || session.workspace.name,
          })
          setStatus('sincronizado')
        },
      )
    }

    channel.subscribe()

    return () => {
      channelRef.current = null
      void sb.removeChannel(channel)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boot])

  if (boot) {
    return (
      <div className="auth-shell">
        <div className="auth-card panel">
          <p className="brand">RifaPIX</p>
          <p className="hint">Sincronizando com a nuvem…</p>
          <p className="hint">Se travar mais de 20s, o app mostra o erro. Verifique a internet.</p>
        </div>
      </div>
    )
  }

  const label =
    syncStatus === 'salvando'
      ? 'Salvando…'
      : syncStatus === 'baixando'
        ? 'Atualizando…'
        : syncStatus === 'offline'
          ? 'Contingência'
          : 'Nuvem ok'

  return (
    <CloudSyncContext.Provider
      value={{
        status: syncStatus,
        error: syncError,
        cloudOk: syncStatus !== 'offline',
        mode,
        retry: () => {
          setSyncError(null)
          void reconnectNow(false)
        },
      }}
    >
      <AppUpdateBanner />
      <CloudRequiredBanner />
      <div
        className={`sync-pill sync-${syncStatus}`}
        title={syncError ? `Erro: ${syncError}` : 'Sincronização contínua com o Supabase'}
      >
        <span className="sync-dot" />
        {label}
        {syncError ? <span className="sync-error-hint"> — passe o mouse</span> : null}
      </div>
      {children}
    </CloudSyncContext.Provider>
  )
}
