import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anon = (import.meta.env.VITE_SUPABASE_ANON_KEY || import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY) as
  | string
  | undefined

export const isSupabaseConfigured = Boolean(url && anon && !url.includes('YOUR_'))

export const supabase: SupabaseClient | null = isSupabaseConfigured
  ? createClient(url!, anon!)
  : null

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
