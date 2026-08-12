import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { loginAdminSession, loginMemberSession } from './auth'
import { useStore } from './store'
import type { AppState } from './types'
import {
  emptyishState,
  ensureOwnerWorkspace,
  fetchByAccessCode,
  loadCloudSession,
  saveByAccessCode,
  saveCloudSession,
  saveOwnerWorkspaceState,
  type CloudSession,
} from './lib/workspace'

type Props = {
  mode: 'admin' | 'member'
  onReady: () => void
  onError: (msg: string) => void
  children: ReactNode
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
  }
}

/** Hidrata o zustand a partir do workspace na nuvem e salva com debounce. */
export function CloudWorkspaceBridge({ mode, onReady, onError, children }: Props) {
  const [boot, setBoot] = useState(true)
  const sessionRef = useRef<CloudSession | null>(loadCloudSession())
  const updatedAtRef = useRef(sessionRef.current?.workspace.updatedAt || '')
  const savingRef = useRef(false)
  const timerRef = useRef<number | null>(null)

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
            useStore.getState().importSnapshot(state!)
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
          useStore.getState().importSnapshot(opened.state)
          const next: CloudSession = {
            role: 'member',
            workspace: opened.meta,
            memberId: session.memberId,
            memberName: session.memberName,
          }
          saveCloudSession(next)
          sessionRef.current = next
          updatedAtRef.current = opened.meta.updatedAt
          loginMemberSession(session.memberId, session.memberName)
        } else {
          onError('Sessão inválida para este modo.')
          return
        }

        if (alive) {
          setBoot(false)
          onReady()
        }
      } catch (err) {
        if (alive) onError(err instanceof Error ? err.message : 'Falha ao abrir workspace')
      }
    })()
    return () => {
      alive = false
    }
  }, [mode, onError, onReady])

  useEffect(() => {
    if (boot) return
    const unsub = useStore.subscribe(() => {
      if (timerRef.current) window.clearTimeout(timerRef.current)
      timerRef.current = window.setTimeout(async () => {
        const session = sessionRef.current || loadCloudSession()
        if (!session || savingRef.current) return
        savingRef.current = true
        try {
          const state = snapshotFromStore()
          let updatedAt: string
          if (session.role === 'admin') {
            updatedAt = await saveOwnerWorkspaceState(session.workspace.id, state)
          } else {
            updatedAt = await saveByAccessCode(session.workspace.accessCode, state, updatedAtRef.current)
          }
          updatedAtRef.current = updatedAt
          session.workspace.updatedAt = updatedAt
          saveCloudSession(session)
          sessionRef.current = session
        } catch (err) {
          console.warn('Falha ao salvar na nuvem', err)
        } finally {
          savingRef.current = false
        }
      }, 900)
    })
    return () => {
      unsub()
      if (timerRef.current) window.clearTimeout(timerRef.current)
    }
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

  return children
}
