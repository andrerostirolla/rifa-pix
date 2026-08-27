import { createClient, type SupabaseClient } from '@supabase/supabase-js'

function normalizeSupabaseUrl(raw: string | undefined) {
  if (!raw) return undefined
  let u = raw.trim().replace(/\/+$/, '')
  // Erros comuns: colar URL do dashboard ou /rest/v1
  u = u.replace(/\/rest\/v1$/i, '').replace(/\/auth\/v1$/i, '')
  if (/supabase\.com\/dashboard/i.test(u)) return undefined
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(u)) return undefined
  return u
}

const url = normalizeSupabaseUrl(import.meta.env.VITE_SUPABASE_URL as string | undefined)
const anonRaw = (import.meta.env.VITE_SUPABASE_ANON_KEY || import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY) as
  | string
  | undefined
const anon = anonRaw?.trim()

/** Detecta JWT service_role (nunca pode ir no browser / VITE_*). */
function looksLikeServiceRoleKey(key: string) {
  try {
    const part = key.split('.')[1]
    if (!part) return false
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'))
    const payload = JSON.parse(json) as { role?: string }
    return payload.role === 'service_role'
  } catch {
    return /service_role/i.test(key)
  }
}

export const supabaseConfigError: string | null = (() => {
  const rawUrl = String(import.meta.env.VITE_SUPABASE_URL || '').trim()
  if (!rawUrl || !anon || rawUrl.includes('YOUR_')) return null
  if (!url) {
    return (
      'VITE_SUPABASE_URL inválida. Use só https://SEU_REF.supabase.co (Project URL), sem /rest/v1 e sem link do dashboard. Depois rode o Deploy de novo.'
    )
  }
  if (looksLikeServiceRoleKey(anon)) {
    return (
      'Chave errada no site: foi colocada a service_role (secreta). ' +
      'No GitHub → Settings → Secrets → Actions, use só a anon public do Supabase em VITE_SUPABASE_ANON_KEY e rode o Deploy de novo.'
    )
  }
  return null
})()

export const supabaseUrl = url

export const isSupabaseConfigured = Boolean(url && anon && !String(import.meta.env.VITE_SUPABASE_URL || '').includes('YOUR_'))

export const supabase: SupabaseClient | null =
  isSupabaseConfigured && !supabaseConfigError && url && anon ? createClient(url, anon) : null

export function authRedirectTo() {
  const base = import.meta.env.BASE_URL || '/rifa-pix/'
  return `${window.location.origin}${base}`
}

export type DbRaffle = {
  id: string
  user_id: string
  name: string
  ticket_price: number
  total_numbers: number
  prize: string
  created_at: string
}

export type DbSale = {
  id: string
  user_id: string
  raffle_id: string
  buyer_name: string
  buyer_phone: string | null
  numbers: number[]
  total_amount: number
  paid_amount: number
  status: 'pendente' | 'parcial' | 'quitado' | 'divergente'
  notes: string | null
  created_at: string
}

export type DbPixPayment = {
  id: string
  user_id: string
  amount: number
  paid_at: string
  payer_name: string
  txid: string | null
  end_to_end_id: string | null
  notes: string | null
  allocated_amount: number
  matched_sale_id: string | null
  provider: string
  created_at: string
}

export type DbAmortization = {
  id: string
  user_id: string
  sale_id: string
  pix_payment_id: string
  amount: number
  note: string | null
  source: string
  created_at: string
}

export type DbPixCharge = {
  id: string
  user_id: string
  sale_id: string
  txid: string
  amount: number
  status: 'pending' | 'paid' | 'expired' | 'cancelled'
  copy_paste: string | null
  qr_code: string | null
  provider: string
  expires_at: string | null
  paid_at: string | null
  created_at: string
}
