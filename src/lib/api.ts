import { supabase } from './supabase'
import type { DbAmortization, DbPixCharge, DbPixPayment, DbRaffle, DbSale } from './supabase'

function client() {
  if (!supabase) throw new Error('Supabase não configurado')
  return supabase
}

export async function fetchAllData(userId: string) {
  const sb = client()
  const [raffles, sales, pixPayments, amortizations, pixCharges] = await Promise.all([
    sb.from('raffles').select('*').eq('user_id', userId).order('created_at', { ascending: false }),
    sb.from('sales').select('*').eq('user_id', userId).order('created_at', { ascending: false }),
    sb.from('pix_payments').select('*').eq('user_id', userId).order('created_at', { ascending: false }),
    sb.from('amortizations').select('*').eq('user_id', userId).order('created_at', { ascending: false }),
    sb.from('pix_charges').select('*').eq('user_id', userId).order('created_at', { ascending: false }),
  ])

  const firstError = [raffles, sales, pixPayments, amortizations, pixCharges].find((r) => r.error)?.error
  if (firstError) throw firstError

  return {
    raffles: (raffles.data || []) as DbRaffle[],
    sales: (sales.data || []) as DbSale[],
    pixPayments: (pixPayments.data || []) as DbPixPayment[],
    amortizations: (amortizations.data || []) as DbAmortization[],
    pixCharges: (pixCharges.data || []) as DbPixCharge[],
  }
}

export async function createRaffle(userId: string, input: { name: string; ticketPrice: number; totalNumbers: number; prize: string }) {
  const { data, error } = await client()
    .from('raffles')
    .insert({
      user_id: userId,
      name: input.name,
      ticket_price: input.ticketPrice,
      total_numbers: input.totalNumbers,
      prize: input.prize,
    })
    .select('*')
    .single()
  if (error) throw error
  return data as DbRaffle
}

export async function deleteRaffle(id: string) {
  const { error } = await client().from('raffles').delete().eq('id', id)
  if (error) throw error
}

export async function createSale(
  userId: string,
  input: { raffleId: string; buyerName: string; buyerPhone?: string; numbers: number[]; totalAmount: number; notes?: string },
) {
  const { data, error } = await client()
    .from('sales')
    .insert({
      user_id: userId,
      raffle_id: input.raffleId,
      buyer_name: input.buyerName,
      buyer_phone: input.buyerPhone || null,
      numbers: input.numbers,
      total_amount: input.totalAmount,
      notes: input.notes || null,
    })
    .select('*')
    .single()
  if (error) throw error
  return data as DbSale
}

export async function deleteSale(id: string) {
  const { error } = await client().from('sales').delete().eq('id', id)
  if (error) throw error
}

export async function createPix(
  userId: string,
  input: { amount: number; paidAt: string; payerName: string; txid?: string; endToEndId?: string; notes?: string },
) {
  const { data, error } = await client()
    .from('pix_payments')
    .insert({
      user_id: userId,
      amount: input.amount,
      paid_at: input.paidAt,
      payer_name: input.payerName,
      txid: input.txid || null,
      end_to_end_id: input.endToEndId || null,
      notes: input.notes || null,
      provider: 'manual',
    })
    .select('*')
    .single()
  if (error) throw error
  return data as DbPixPayment
}

export async function createPixBulk(
  userId: string,
  inputs: Array<{ amount: number; paidAt: string; payerName: string; txid?: string; endToEndId?: string; notes?: string }>,
) {
  const rows = inputs.map((input) => ({
    user_id: userId,
    amount: input.amount,
    paid_at: input.paidAt,
    payer_name: input.payerName,
    txid: input.txid || null,
    end_to_end_id: input.endToEndId || null,
    notes: input.notes || null,
    provider: 'csv',
  }))
  const { data, error } = await client().from('pix_payments').insert(rows).select('*')
  if (error) throw error
  return (data || []) as DbPixPayment[]
}

export async function importCsvAndSettleByTxid(
  userId: string,
  inputs: Array<{ amount: number; paidAt: string; payerName: string; txid?: string; endToEndId?: string; notes?: string }>,
) {
  const imported = await createPixBulk(userId, inputs)
  const { data: charges, error } = await client()
    .from('pix_charges')
    .select('*')
    .eq('user_id', userId)
    .eq('status', 'pending')
  if (error) throw error

  const pending = (charges || []) as DbPixCharge[]
  const byTxid = new Map(pending.map((c) => [c.txid.trim().toLowerCase(), c]))
  let settled = 0

  for (const payment of imported) {
    const keys = [payment.txid, payment.end_to_end_id]
      .map((v) => (v || '').trim().toLowerCase())
      .filter(Boolean)
    const charge = keys.map((k) => byTxid.get(k)).find(Boolean)
    if (!charge) continue

    const amount = Math.min(Number(payment.amount), Number(charge.amount))
    try {
      await amortize(userId, charge.sale_id, payment.id, amount, 'Baixa automática por TXID (CSV)')
      await client()
        .from('pix_charges')
        .update({ status: 'paid', paid_at: new Date().toISOString() })
        .eq('id', charge.id)
      byTxid.delete(charge.txid.trim().toLowerCase())
      settled += 1
    } catch {
      // keep going; remaining stay for manual conference
    }
  }

  const withId = inputs.filter((r) => r.txid || r.endToEndId).length
  return {
    imported: imported.length,
    settled,
    unmatchedWithTxid: Math.max(0, withId - settled),
  }
}

export async function attachTxidToSale(userId: string, saleId: string, txid: string, amount?: number) {
  const clean = txid.trim()
  if (!clean) throw new Error('Informe o TXID')

  const { data: sale, error: saleError } = await client()
    .from('sales')
    .select('*')
    .eq('id', saleId)
    .eq('user_id', userId)
    .single()
  if (saleError || !sale) throw saleError || new Error('Venda não encontrada')

  const open = Number(sale.total_amount) - Number(sale.paid_amount)
  const value = amount ?? open
  if (!(value > 0) || value > open + 0.009) throw new Error('Valor inválido')

  const { data, error } = await client()
    .from('pix_charges')
    .insert({
      user_id: userId,
      sale_id: saleId,
      txid: clean,
      amount: value,
      status: 'pending',
      provider: 'manual-txid',
      copy_paste: clean,
      qr_code: null,
    })
    .select('*')
    .single()
  if (error) throw error
  return data as DbPixCharge
}

export async function deletePix(id: string) {
  const { error } = await client().from('pix_payments').delete().eq('id', id)
  if (error) throw error
}

export async function amortize(userId: string, saleId: string, pixPaymentId: string, amount: number, note?: string) {
  const { error } = await client().rpc('amortize_sale_from_pix', {
    p_user_id: userId,
    p_sale_id: saleId,
    p_pix_payment_id: pixPaymentId,
    p_amount: amount,
    p_note: note || null,
    p_source: 'manual',
  })
  if (error) throw error
}

export async function createPixCharge(saleId: string, amount?: number) {
  const sb = client()
  const { data, error } = await sb.functions.invoke('create-pix-charge', {
    body: { saleId, amount },
  })
  if (error) throw error
  if (data?.error) throw new Error(data.error)
  return data.charge as DbPixCharge
}

export async function simulatePixPayment(chargeId: string, payerName?: string) {
  const sb = client()
  const { data, error } = await sb.functions.invoke('simulate-pix-payment', {
    body: { chargeId, payerName },
  })
  if (error) throw error
  if (data?.error) throw new Error(data.error)
  return data
}
