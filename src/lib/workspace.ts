import type { AppState } from '../types'
import { supabase } from './supabase'

export type WorkspaceMeta = {
  id: string
  name: string
  accessCode: string
  updatedAt: string
  ownerId?: string
}

export type CloudSession =
  | { role: 'admin'; workspace: WorkspaceMeta }
  | { role: 'member'; workspace: WorkspaceMeta; memberId: string; memberName: string }

const CLOUD_SESSION_KEY = 'rifa-pix-cloud-session-v1'

function client() {
  if (!supabase) throw new Error('Supabase não configurado')
  return supabase
}

export function loadCloudSession(): CloudSession | null {
  try {
    const raw = sessionStorage.getItem(CLOUD_SESSION_KEY)
    return raw ? (JSON.parse(raw) as CloudSession) : null
  } catch {
    return null
  }
}

export function saveCloudSession(session: CloudSession | null) {
  if (!session) sessionStorage.removeItem(CLOUD_SESSION_KEY)
  else sessionStorage.setItem(CLOUD_SESSION_KEY, JSON.stringify(session))
}

function mapWorkspace(row: {
  id: string
  name: string
  access_code: string
  updated_at: string
  owner_id?: string
}): WorkspaceMeta {
  return {
    id: row.id,
    name: row.name,
    accessCode: row.access_code,
    updatedAt: row.updated_at,
    ownerId: row.owner_id,
  }
}

export async function ensureOwnerWorkspace(name?: string): Promise<{ meta: WorkspaceMeta; state: AppState | null }> {
  const sb = client()
  const { data, error } = await sb.rpc('ensure_my_workspace', { p_name: name || 'RifaPIX' })
  if (error) throw error
  const row = data as {
    id: string
    name: string
    access_code: string
    updated_at: string
    owner_id: string
    state: AppState | Record<string, unknown>
  }
  const state = row.state && typeof row.state === 'object' && Array.isArray((row.state as AppState).raffles)
    ? (row.state as AppState)
    : null
  return { meta: mapWorkspace(row), state }
}

export async function saveOwnerWorkspaceState(workspaceId: string, state: AppState): Promise<string> {
  const sb = client()
  const { data, error } = await sb
    .from('workspaces')
    .update({ state, updated_at: new Date().toISOString() })
    .eq('id', workspaceId)
    .select('updated_at')
    .single()
  if (error) throw error
  return data.updated_at as string
}

export async function peekMembers(accessCode: string): Promise<{
  workspaceId: string
  name: string
  updatedAt: string
  members: Array<{ id: string; name: string }>
}> {
  const sb = client()
  const { data, error } = await sb.rpc('peek_workspace_members', { p_code: accessCode.trim() })
  if (error) throw error
  const payload = data as {
    workspaceId: string
    name: string
    updatedAt: string
    members: Array<{ id: string; name: string }>
  }
  return payload
}

export async function openAsMember(
  accessCode: string,
  memberId: string,
  pin: string,
): Promise<{ meta: WorkspaceMeta; state: AppState; memberId: string; memberName: string }> {
  const sb = client()
  const { data, error } = await sb.rpc('member_open_workspace', {
    p_code: accessCode.trim(),
    p_member_id: memberId,
    p_pin: pin,
  })
  if (error) throw error
  const payload = data as {
    workspaceId: string
    name: string
    accessCode: string
    updatedAt: string
    state: AppState
    member: { id: string; name: string }
  }
  return {
    meta: {
      id: payload.workspaceId,
      name: payload.name,
      accessCode: payload.accessCode,
      updatedAt: payload.updatedAt,
    },
    state: payload.state,
    memberId: payload.member.id,
    memberName: payload.member.name,
  }
}

export async function saveByAccessCode(
  accessCode: string,
  state: AppState,
  expectedUpdatedAt?: string,
): Promise<string> {
  const sb = client()
  const { data, error } = await sb.rpc('save_workspace_by_code', {
    p_code: accessCode.trim(),
    p_state: state,
    p_expected_updated_at: expectedUpdatedAt || null,
  })
  if (error) throw error
  return (data as { updatedAt: string }).updatedAt
}

export async function fetchOwnerWorkspace(workspaceId: string): Promise<{ meta: WorkspaceMeta; state: AppState }> {
  const sb = client()
  const { data, error } = await sb.from('workspaces').select('*').eq('id', workspaceId).single()
  if (error) throw error
  const row = data as {
    id: string
    name: string
    access_code: string
    updated_at: string
    owner_id: string
    state: AppState
  }
  return {
    meta: mapWorkspace(row),
    state: row.state,
  }
}

export async function fetchByAccessCode(accessCode: string): Promise<{ meta: WorkspaceMeta; state: AppState }> {
  const sb = client()
  const { data, error } = await sb.rpc('fetch_workspace_by_code', { p_code: accessCode.trim() })
  if (error) throw error
  const payload = data as {
    workspaceId: string
    name: string
    accessCode: string
    updatedAt: string
    state: AppState
  }
  return {
    meta: {
      id: payload.workspaceId,
      name: payload.name,
      accessCode: payload.accessCode,
      updatedAt: payload.updatedAt,
    },
    state: payload.state,
  }
}

export function emptyishState(state: AppState | null | undefined): boolean {
  if (!state) return true
  return !(state.raffles?.length || state.members?.length || state.sales?.length || state.blocks?.length)
}
