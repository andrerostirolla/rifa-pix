import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { loginAdminSession, loginMemberSession } from './auth'
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
  }
}

function isNewer(remoteIso: string, localIso: string) {
  if (!remoteIso) return false
  if (!localIso) return true
  return new Date(remoteIso).getTime() > new Date(localIso).getTime() + 20
}

function syncChannelName(accessCode: string) {
  return `rifa-sync-${accessCode.trim().toUpperCase()}`
}

/** Hidrata o zustand, salva rápido, broadcast + poll curto entre aparelhos. */
export function CloudWorkspaceBridge({ mode, onReady, onError, children }: Props) {
  const [boot, setBoot] = useState(true)
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('baixando')
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

  const pushNow = async () => {
    const session = sessionRef.current || loadCloudSession()
    if (!session || savingRef.current || applyingRemoteRef.current) return
    savingRef.current = true
    dirtyRef.current = false
    setSyncStatus('salvando')
    try {
      const state = snapshotFromStore()
      let updatedAt: string
      if (session.role === 'admin') {
        if (!session.workspace.id) throw new Error('Workspace sem id')
        updatedAt = await saveOwnerWorkspaceState(session.workspace.id, state)
      } else {
        updatedAt = await saveByAccessCode(session.workspace.accessCode, state, updatedAtRef.current)
      }
      updatedAtRef.current = updatedAt
      session.workspace.updatedAt = updatedAt
      saveCloudSession(session)
      sessionRef.current = session
      // evita eco imediato do próprio save
      skipPullUntilRef.current = Date.now() + 350
      setSyncStatus('sincronizado')
      void broadcastUpdated(updatedAt)
    } catch (err) {
      console.warn('Falha ao salvar na nuvem', err)
      setSyncStatus('offline')
      dirtyRef.current = true
      try {
        await pullNow(true)
      } catch {
        /* ignore */
      }
    } finally {
      savingRef.current = false
    }
  }

  const pullNow = async (force = false) => {
    const session = sessionRef.current || loadCloudSession()
    if (!session || pullingRef.current || savingRef.current) return
    if (!force && Date.now() < skipPullUntilRef.current) return

    // Se tem alteração local pendente, sobe antes de baixar
    if (dirtyRef.current && !force) {
      await pushNow()
      return
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
      } else {
        setSyncStatus('sincronizado')
      }
    } catch (err) {
      console.warn('Falha ao puxar da nuvem', err)
      setSyncStatus('offline')
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
    <>
      <div className={`sync-pill sync-${syncStatus}`} title="Sincronização contínua com o Supabase">
        <span className="sync-dot" />
        {label}
      </div>
      {children}
    </>
  )
}
