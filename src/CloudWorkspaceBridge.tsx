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
  const pullingRef = useRef(false)
  const applyingRemoteRef = useRef(false)
  const dirtyRef = useRef(false)
  const pushTimerRef = useRef<number | null>(null)
  const skipPullUntilRef = useRef(0)
  const channelRef = useRef<ReturnType<NonNullable<typeof supabase>['channel']> | null>(null)

  const applyRemote = (state: AppState, updatedAt: string, meta?: Partial<CloudSession['workspace']>) => {
    applyingRemoteRef.current = true
    dirtyRef.current = false
    useStore.getState().importSnapshot(state)
    updatedAtRef.current = updatedAt
    const session = sessionRef.current
    if (session) {
      session.workspace = { ...session.workspace, ...meta, updatedAt }
      saveCloudSession(session)
      sessionRef.current = session
    }
    window.setTimeout(() => {
      applyingRemoteRef.current = false
    }, 0)
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
    dirtyRef.current = false
    setSyncStatus('salvando')
    try {
      let { state } = await migrateProofsIfNeeded(snapshotFromStore())
      let updatedAt: string
      try {
        if (session.role === 'admin') {
          if (!session.workspace.id) throw new Error('Workspace sem id')
          updatedAt = await saveOwnerWorkspaceState(session.workspace.id, state)
        } else {
          updatedAt = await saveByAccessCode(session.workspace.accessCode, state, updatedAtRef.current)
        }
      } catch (firstErr) {
        const msg = firstErr instanceof Error ? firstErr.message : String(firstErr)
        if (!/desatualiz|conflict|updated/i.test(msg)) throw firstErr
        // Nuvem mudou enquanto estava offline: mescla vendas locais e sobe de novo
        const opened =
          session.role === 'admin' && session.workspace.id
            ? await fetchOwnerWorkspace(session.workspace.id)
            : await fetchByAccessCode(session.workspace.accessCode)
        state = mergeContingencyState(opened.state, snapshotFromStore())
        applyingRemoteRef.current = true
        useStore.getState().importSnapshot(state)
        window.setTimeout(() => {
          applyingRemoteRef.current = false
        }, 0)
        if (session.role === 'admin' && session.workspace.id) {
          updatedAt = await saveOwnerWorkspaceState(session.workspace.id, state)
        } else {
          updatedAt = await saveByAccessCode(session.workspace.accessCode, state, opened.meta.updatedAt)
        }
      }
      updatedAtRef.current = updatedAt
      session.workspace.updatedAt = updatedAt
      saveCloudSession(session)
      sessionRef.current = session
      skipPullUntilRef.current = Date.now() + 350
      setSyncStatus('sincronizado')
      setSyncError(null)
      void broadcastUpdated(updatedAt)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Falha ao salvar'
      console.warn('Falha ao salvar na nuvem', err)
      setSyncStatus('offline')
      setSyncError(msg)
      dirtyRef.current = true
    } finally {
      savingRef.current = false
    }
  }

  const pullNow = async (force = false) => {
    const session = sessionRef.current || loadCloudSession()
    if (!session || pullingRef.current || savingRef.current) return
    if (!force && Date.now() < skipPullUntilRef.current) return

    // Contingência offline: sempre sobe o local sujo ANTES de baixar (senão perde venda em dinheiro)
    if (dirtyRef.current) {
      await pushNow()
      if (dirtyRef.current) return
      if (!force) return
    }

    pullingRef.current = true
    try {
      // checagem barata primeiro (se RPC existir); senão cai no fetch completo
      try {
        const remoteTs = await peekWorkspaceUpdatedAt(session.workspace.accessCode)
        if (!force && !isNewer(remoteTs, updatedAtRef.current)) {
          setSyncStatus('sincronizado')
          return
        }
      } catch {
        /* RPC ainda não aplicada — segue com fetch completo */
      }

      const opened =
        session.role === 'admin' && session.workspace.id
          ? await fetchOwnerWorkspace(session.workspace.id)
          : await fetchByAccessCode(session.workspace.accessCode)
      if (force || isNewer(opened.meta.updatedAt, updatedAtRef.current)) {
        setSyncStatus('baixando')
        applyRemote(opened.state, opened.meta.updatedAt, opened.meta)
        setSyncStatus('sincronizado')
        setSyncError(null)
      } else {
        setSyncStatus('sincronizado')
        setSyncError(null)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Falha ao baixar'
      console.warn('Falha ao puxar da nuvem', err)
      setSyncStatus('offline')
      setSyncError(msg)
    } finally {
      pullingRef.current = false
    }
  }

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const session = loadCloudSession()
        sessionRef.current = session
        if (!session) {
          onError('Sessão nuvem ausente. Entre de novo.')
          return
        }

        if (mode === 'admin' && session.role === 'admin') {
          const { meta, state } = await ensureOwnerWorkspace(session.workspace.name)
          const next: CloudSession = { role: 'admin', workspace: meta }
          saveCloudSession(next)
          sessionRef.current = next
          updatedAtRef.current = meta.updatedAt
          if (!emptyishState(state)) {
            applyRemote(state!, meta.updatedAt, meta)
          } else {
            const local = snapshotFromStore()
            if (!emptyishState(local)) {
              const updatedAt = await saveOwnerWorkspaceState(meta.id, local)
              updatedAtRef.current = updatedAt
              next.workspace.updatedAt = updatedAt
              saveCloudSession(next)
            }
          }
          await loginAdminSession(meta.name || 'ADM')
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
          onError('Sessão inválida para este modo.')
          return
        }

        // Move comprovantes base64 antigos para o Storage e enxuga o JSON
        if (alive) {
          const { moved } = await migrateProofsIfNeeded(snapshotFromStore())
          if (moved > 0) {
            dirtyRef.current = true
            await pushNow()
          }
        }

        if (alive) {
          setBoot(false)
          setSyncStatus('sincronizado')
          onReady()
        }
      } catch (err) {
        if (alive) onError(err instanceof Error ? err.message : 'Falha ao abrir workspace')
      }
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, onError, onReady])

  // Push local → nuvem
  useEffect(() => {
    if (boot) return
    const unsub = useStore.subscribe(() => {
      if (applyingRemoteRef.current) return
      dirtyRef.current = true
      setSyncStatus('salvando')
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
  }, [boot])

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

  // Pull periódico + foco/visibilidade
  useEffect(() => {
    if (boot) return
    const id = window.setInterval(() => {
      void pullNow(false)
    }, PULL_INTERVAL_MS)
    const onFocus = () => {
      void pullNow(true)
    }
    const onOnline = () => {
      void pullNow(true)
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void pullNow(true)
    }
    window.addEventListener('focus', onFocus)
    window.addEventListener('online', onOnline)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.clearInterval(id)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('online', onOnline)
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
          if (dirtyRef.current || savingRef.current) return
          setSyncStatus('baixando')
          applyRemote(row.state, row.updated_at, {
            updatedAt: row.updated_at,
            accessCode: row.access_code || session.workspace.accessCode,
            name: row.name || session.workspace.name,
          })
          setSyncStatus('sincronizado')
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
          ? 'Sem nuvem'
          : 'Nuvem ok'

  return (
    <CloudSyncContext.Provider
      value={{
        status: syncStatus,
        error: syncError,
        cloudOk: syncStatus !== 'offline',
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
