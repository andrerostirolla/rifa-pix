import { supabase } from './supabase'
import { loadCloudSession } from './workspace'

export type ChatMessage = {
  id: string
  workspace_id: string
  author_role: 'admin' | 'member'
  author_member_id?: string | null
  author_name: string
  body: string
  created_at: string
}

function client() {
  if (!supabase) throw new Error('Supabase não configurado')
  return supabase
}

function accessCode() {
  const session = loadCloudSession()
  if (!session?.workspace.accessCode) throw new Error('Sessão nuvem sem código da equipe')
  return session.workspace.accessCode
}

export async function listChatMessages(limit = 120): Promise<ChatMessage[]> {
  const sb = client()
  const { data, error } = await sb.rpc('list_chat_messages', {
    p_code: accessCode(),
    p_limit: limit,
  })
  if (error) throw error
  const payload = data as { messages?: ChatMessage[] }
  const list = payload.messages || []
  return [...list].sort((a, b) => a.created_at.localeCompare(b.created_at))
}

export async function sendChatMessage(input: {
  authorName: string
  body: string
  authorRole: 'admin' | 'member'
  authorMemberId?: string
}): Promise<ChatMessage> {
  const sb = client()
  const { data, error } = await sb.rpc('send_chat_message', {
    p_code: accessCode(),
    p_author_name: input.authorName,
    p_body: input.body,
    p_author_role: input.authorRole,
    p_author_member_id: input.authorMemberId || null,
  })
  if (error) throw error
  return data as ChatMessage
}
