import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-webhook-secret',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  try {
    const expectedSecret = Deno.env.get('PIX_WEBHOOK_SECRET')
    const gotSecret = req.headers.get('x-webhook-secret')
    if (expectedSecret && gotSecret !== expectedSecret) {
      return json({ error: 'Invalid webhook secret' }, 401)
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const admin = createClient(supabaseUrl, serviceKey)

    const payload = await req.json()
    // Normalize common PSP shapes + our mock.
    const txid = String(payload.txid || payload.txId || payload.data?.txid || '')
    const endToEndId = String(payload.endToEndId || payload.e2e || payload.data?.endToEndId || '') || null
    const payerName = String(payload.payerName || payload.pagador || payload.data?.payerName || 'Pagador PIX')
    const amount = Number(payload.amount || payload.valor || payload.data?.amount || 0)
    const paidAtRaw = String(payload.paidAt || payload.horario || payload.data?.paidAt || new Date().toISOString())
    const paidAt = paidAtRaw.slice(0, 10)

    if (!txid && !endToEndId) return json({ error: 'txid ou endToEndId obrigatório' }, 400)
    if (!(amount > 0)) return json({ error: 'amount inválido' }, 400)

    let chargeQuery = admin.from('pix_charges').select('*').eq('status', 'pending')
    if (txid) chargeQuery = chargeQuery.eq('txid', txid)
    const { data: charge } = await chargeQuery.maybeSingle()

    // Orphan payment without charge: require userId in payload.
    if (!charge) {
      const userId = String(payload.userId || '')
      if (!userId) {
        return json({ error: 'Cobrança não encontrada e userId ausente para órfão' }, 404)
      }
      const { data: orphan, error } = await admin
        .from('pix_payments')
        .insert({
          user_id: userId,
          amount,
          paid_at: paidAt,
          payer_name: payerName,
          txid: txid || null,
          end_to_end_id: endToEndId,
          notes: 'Webhook sem cobrança vinculada',
          provider: String(payload.provider || 'webhook'),
          raw_payload: payload,
        })
        .select('*')
        .maybeSingle()

      if (error) return json({ error: error.message }, 400)
      return json({ ok: true, mode: 'orphan', payment: orphan })
    }

    // Idempotency: already paid?
    if (charge.status === 'paid') return json({ ok: true, mode: 'already_paid', chargeId: charge.id })

    const { data: payment, error: payError } = await admin
      .from('pix_payments')
      .insert({
        user_id: charge.user_id,
        amount,
        paid_at: paidAt,
        payer_name: payerName,
        txid: txid || charge.txid,
        end_to_end_id: endToEndId,
        notes: 'Baixa automática via webhook',
        provider: String(payload.provider || charge.provider || 'webhook'),
        matched_sale_id: charge.sale_id,
        raw_payload: payload,
      })
      .select('*')
      .single()

    if (payError) return json({ error: payError.message }, 400)

    const applyAmount = Math.min(Number(amount), Number(charge.amount))
    const { error: amortError } = await admin.rpc('amortize_sale_from_pix', {
      p_user_id: charge.user_id,
      p_sale_id: charge.sale_id,
      p_pix_payment_id: payment.id,
      p_amount: applyAmount,
      p_note: 'Baixa automática PIX',
      p_source: 'webhook',
    })

    if (amortError) return json({ error: amortError.message }, 400)

    await admin
      .from('pix_charges')
      .update({ status: 'paid', paid_at: new Date().toISOString() })
      .eq('id', charge.id)

    return json({
      ok: true,
      mode: 'auto_settled',
      chargeId: charge.id,
      saleId: charge.sale_id,
      paymentId: payment.id,
      amount: applyAmount,
    })
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Erro interno' }, 500)
  }
})
