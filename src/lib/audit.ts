import { loadCloudSession } from './workspace'
import { supabase } from './supabase'
import { getAuthRecord, getSession } from '../auth'
import { useStore } from '../store'
import type { AuditEntry } from '../types'

function actorNameNow() {
  const session = getSession()
  if (session?.role === 'member') return session.memberName || 'Membro'
  // ADM: o memberName da sessão pode ser o nome da equipe — prefere o nome da pessoa
  const auth = getAuthRecord()
  if (auth?.organizerName) return auth.organizerName
  const cloud = loadCloudSession()
  const wsName = cloud?.workspace.name
  if (session?.memberName && session.memberName !== wsName) return session.memberName
  return 'ADM'
}

export function logAudit(action: string, detail?: string, meta?: Record<string, string | undefined>) {
  const cleanMeta = Object.fromEntries(
    Object.entries(meta || {}).filter(([, v]) => Boolean(v && String(v).trim())),
  ) as Record<string, string>

  const entry: AuditEntry = {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    actorName: actorNameNow(),
    action,
    detail: detail?.trim() || undefined,
    meta: Object.keys(cleanMeta).length ? cleanMeta : undefined,
  }
  useStore.getState().pushAudit(entry)

  const cloud = loadCloudSession()
  if (cloud?.workspace.id && supabase && cloud.role === 'admin') {
    void supabase.rpc('append_workspace_audit', {
      p_workspace_id: cloud.workspace.id,
      p_actor_name: entry.actorName,
      p_action: entry.action,
      p_detail: { ...(detail ? { text: detail } : {}), ...cleanMeta },
    }).then(({ error }) => {
      if (error) console.warn('Audit cloud:', error.message)
    })
  }
}

export async function createWorkspaceAdmin(input: {
  workspaceId: string
  displayName: string
  email: string
  password: string
}) {
  if (!supabase) throw new Error('Supabase não configurado')
  const { data, error } = await supabase.functions.invoke('create-workspace-admin', {
    body: input,
  })
  if (error) throw new Error(error.message || 'Falha ao criar ADM')
  if (data?.error) throw new Error(String(data.error))
  return data
}
