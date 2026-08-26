import { supabase } from './supabase'
import type { Sale } from '../types'

export type WorkspacePixCharge = {
  id: string
  saleId: string
  txid: string
  amount: number
  copyPaste: string
  qrCode: string
  status: string
  expiresAt?: string
  provider?: string
}

const REMEMBER_KEY = 'rifa-pix-remember-member-v1'

export function getStoredMemberPin(memberId: string): string | null {
  try {
    const raw = localStorage.getItem(REMEMBER_KEY)
    if (!raw) return null
    const data = JSON.parse(raw) as { memberId?: string; pin?: string; rememberPin?: boolean }
    if (data.memberId === memberId && data.pin) return data.pin
  } catch {
    /* ignore */
  }
  return null
}

async function readFunctionError(error: unknown): Promise<string> {
  if (!error || typeof error !== 'object') return 'Erro ao chamar Edge Function'
  const err = error as { message?: string; context?: Response }
  if (err.context && typeof err.context.json === 'function') {
    try {
      const body = (await err.context.json()) as { error?: string }
      if (body?.error) return body.error
    } catch {
      /* ignore */
    }
  }
  return err.message || 'Edge Function retornou erro'
}

export async function createWorkspacePixCharge(input: {
  accessCode: string
  memberId: string
  pin: string
  saleId: string
  amount: number
  buyerName?: string
  sale?: Sale
}): Promise<WorkspacePixCharge> {
  if (!supabase) throw new Error('Supabase não configurado')
  const { data, error } = await supabase.functions.invoke('create-pix-charge-workspace', {
    body: input,
  })
  if (error) throw new Error(await readFunctionError(error))
  if (data?.error) throw new Error(String(data.error))
  const c = data.charge
  return {
    id: String(c.id),
    saleId: String(c.saleId),
    txid: String(c.txid),
    amount: Number(c.amount),
    copyPaste: String(c.copyPaste || ''),
    qrCode: String(c.qrCode || c.copyPaste || ''),
    status: String(c.status || 'pending'),
    expiresAt: c.expiresAt ? String(c.expiresAt) : undefined,
    provider: c.provider ? String(c.provider) : undefined,
  }
}

export async function checkWorkspacePixCharge(input: {
  accessCode: string
  memberId: string
  pin: string
  txid: string
}): Promise<{
  ok: boolean
  status: string
  mode: string
  saleId?: string
  amount?: number
  message?: string
}> {
  if (!supabase) throw new Error('Supabase não configurado')
  const { data, error } = await supabase.functions.invoke('check-pix-charge-workspace', {
    body: input,
  })
  if (error) throw new Error(await readFunctionError(error))
  if (data?.error) throw new Error(String(data.error))
  return data
}

export async function listWorkspacePixCharges(accessCode: string): Promise<
  Array<{
    id: string
    saleId: string
    memberId?: string
    txid: string
    amount: number
    status: string
    copyPaste?: string
    provider?: string
    expiresAt?: string
    paidAt?: string
    createdAt?: string
  }>
> {
  if (!supabase) throw new Error('Supabase não configurado')
  const { data, error } = await supabase.functions.invoke('list-pix-charges-workspace', {
    body: { accessCode },
  })
  if (error) throw new Error(await readFunctionError(error))
  if (data?.error) throw new Error(String(data.error))
  return Array.isArray(data?.charges) ? data.charges : []
}

export function qrImageUrl(payload: string, size = 240) {
  return `https://quickchart.io/qr?size=${size}&margin=1&text=${encodeURIComponent(payload)}`
}
