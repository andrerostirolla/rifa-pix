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
const MEMBER_PIN_HASH_KEY = 'rifa-pix-member-pin-hash-v1'

function client() {
  if (!supabase) throw new Error('Supabase não configurado')
  return supabase
}

export function loadCloudSession(): CloudSession | null {
  try {
    const raw = sessionStorage.getItem(CLOUD_SESSION_KEY) || localStorage.getItem(CLOUD_SESSION_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as CloudSession
    sessionStorage.setItem(CLOUD_SESSION_KEY, raw)
    return parsed
  } catch {
    return null
  }
}

export function saveCloudSession(session: CloudSession | null) {
  if (!session) {
    sessionStorage.removeItem(CLOUD_SESSION_KEY)
    localStorage.removeItem(CLOUD_SESSION_KEY)
  } else {
    const raw = JSON.stringify(session)
    sessionStorage.setItem(CLOUD_SESSION_KEY, raw)
    localStorage.setItem(CLOUD_SESSION_KEY, raw)
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('rifa-cloud-session', { detail: session }))
  }
}

/** Atualiza meta/updatedAt e avisa o bridge (evita “Sem nuvem” após PIX no servidor). */
export function syncCloudSessionMeta(meta: Partial<WorkspaceMeta> & { updatedAt?: string }) {
  const session = loadCloudSession()
  if (!session) return null
  session.workspace = { ...session.workspace, ...meta }
  saveCloudSession(session)
  return session
}

async function pinHash(code: string, memberId: string, pin: string) {
  const bytes = new TextEncoder().encode(`${code.trim().toUpperCase()}|${memberId}|${pin.trim()}`)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** O servidor não manda mais os PINs; guarda só o hash do próprio PIN para entrar sem rede. */
export async function rememberMemberPinHash(code: string, memberId: string, pin: string) {
  try {
    localStorage.setItem(MEMBER_PIN_HASH_KEY, await pinHash(code, memberId, pin))
  } catch {
    /* sem storage: login offline fica indisponível */
  }
}

export async function checkMemberPinHash(code: string, memberId: string, pin: string): Promise<boolean> {
  try {
    const saved = localStorage.getItem(MEMBER_PIN_HASH_KEY)
    return !!saved && saved === (await pinHash(code, memberId, pin))
  } catch {
    return false
  }
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
  if (error) {
    const msg = error.message || String(error)
    if (/does not exist|workspace_admins/i.test(msg)) {
      throw new Error(
        'Migration pendente: rode supabase/migrations/20260826140000_workspace_admins_audit.sql no SQL Editor do Supabase.',
      )
    }
    throw new Error(msg)
  }
  if (!data) throw new Error('Workspace vazio retornado pelo servidor.')
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

/**
 * ADM grava o workspace. A tabela passa por RLS, e ADM auxiliar (não dono) pode
 * ficar sem permissão; nesse caso cai na RPC security definer pelo código da equipe.
 */
export async function saveOwnerWorkspaceState(
  workspaceId: string,
  state: AppState,
  accessCode?: string,
): Promise<string> {
  const sb = client()
  const { data, error } = await sb
    .from('workspaces')
    .update({ state, updated_at: new Date().toISOString() })
    .eq('id', workspaceId)
    .select('updated_at')
    .maybeSingle()
  if (!error && data?.updated_at) return data.updated_at as string
  if (!accessCode) {
    throw error || new Error('Sem permissão para gravar o workspace (RLS). Rode scripts/FIX-workspace-admin-rls.sql.')
  }
  return saveByAccessCode(accessCode, state)
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
  if (data && typeof data === 'object' && 'error' in data) throw new Error(String((data as { error: unknown }).error))
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

export async function fetchOwnerWorkspace(
  workspaceId: string,
  accessCode?: string,
): Promise<{ meta: WorkspaceMeta; state: AppState }> {
  const sb = client()
  const { data, error } = await sb.from('workspaces').select('*').eq('id', workspaceId).maybeSingle()
  if (error || !data) {
    if (accessCode) return fetchByAccessCode(accessCode)
    throw error || new Error('Workspace não encontrado ou sem permissão de leitura (RLS).')
  }
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

export async function peekWorkspaceUpdatedAt(accessCode: string): Promise<string> {
  const sb = client()
  const { data, error } = await sb.rpc('workspace_updated_at', { p_code: accessCode.trim() })
  if (error) throw error
  return String(data)
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

/** Grava o estado atual na nuvem antes de operações que leem o workspace no servidor. */
export async function flushWorkspaceToCloud(state: AppState): Promise<void> {
  const session = loadCloudSession()
  if (!session) return
  try {
    let updatedAt: string
    if (session.role === 'admin' && session.workspace.id) {
      updatedAt = await saveOwnerWorkspaceState(session.workspace.id, state, session.workspace.accessCode)
    } else {
      updatedAt = await saveByAccessCode(
        session.workspace.accessCode,
        state,
        session.workspace.updatedAt,
      )
    }
    session.workspace = { ...session.workspace, updatedAt }
    saveCloudSession(session)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // Conflito de versão: sobe de novo sem expected (última escrita ganha) ou com peek
    if (/desatualiz|conflict|updated/i.test(msg)) {
      const updatedAt = await saveByAccessCode(session.workspace.accessCode, state)
      session.workspace = { ...session.workspace, updatedAt }
      saveCloudSession(session)
      return
    }
    throw err
  }
}

/** ADM: pede gravação na nuvem sem reagir a cada pull/remoto no zustand. */
export function requestCloudPush() {
  window.dispatchEvent(new CustomEvent('rifa-request-cloud-push'))
}
