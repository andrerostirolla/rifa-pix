import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1'
import { normalizeSicoobWebhook } from '../_shared/sicoob.ts'

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
  // Sicoob costuma POST em {urlCadastrada}/pix
  const path = new URL(req.url).pathname.replace(/\/+$/, '')
  const okPath =
    path.endsWith('/pix-webhook') ||
    path.endsWith('/pix-webhook/pix') ||
    path.endsWith('/pix')
  if (!okPath) {
    return json({ error: 'Not found', path }, 404)
  }
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  try {
    const expectedSecret = Deno.env.get('PIX_WEBHOOK_SECRET')
    const gotSecret = req.headers.get('x-webhook-secret')
    // Sicoob/Bacen nem sempre manda nosso secret — se PIX_WEBHOOK_REQUIRE_SECRET=1, exige.
    const requireSecret = (Deno.env.get('PIX_WEBHOOK_REQUIRE_SECRET') || '') === '1'
    if (expectedSecret && requireSecret && gotSecret !== expectedSecret) {
      return json({ error: 'Invalid webhook secret' }, 401)
    }
    if (expectedSecret && gotSecret && gotSecret !== expectedSecret) {
      return json({ error: 'Invalid webhook secret' }, 401)
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const admin = createClient(supabaseUrl, serviceKey)

    const payload = (await req.json()) as Record<string, unknown>
    const events = normalizeSicoobWebhook(payload)
    const results = []

    for (const ev of events) {
      const txid = ev.txid
      const endToEndId = ev.endToEndId || null
      const payerName = ev.payerName || 'Pagador PIX'
      const amount = Number(ev.amount || 0)
      const paidAt = String(ev.paidAt || new Date().toISOString()).slice(0, 10)

      if (!txid && !endToEndId) {
        results.push({ ok: false, error: 'txid ou endToEndId obrigatório' })
        continue
      }
      if (!(amount > 0)) {
        results.push({ ok: false, error: 'amount inválido', txid })
        continue
      }

      let chargeQuery = admin.from('pix_charges').select('*').eq('status', 'pending')
      if (txid) chargeQuery = chargeQuery.eq('txid', txid)
      const { data: charge } = await chargeQuery.maybeSingle()

      if (!charge && txid) {
        const { data: wsCharge } = await admin
          .from('workspace_pix_charges')
          .select('*')
          .eq('status', 'pending')
          .eq('txid', txid)
          .maybeSingle()

        if (wsCharge) {
          const { data: applied, error: wsErr } = await admin.rpc('apply_workspace_pix_payment', {
            p_workspace_id: wsCharge.workspace_id,
            p_txid: txid,
            p_amount: amount,
            p_paid_at: new Date().toISOString(),
          })
          if (wsErr) {
            results.push({ ok: false, error: wsErr.message, txid, mode: 'workspace' })
          } else {
            results.push({ ok: true, mode: 'workspace_paid', saleId: wsCharge.workspace_sale_id, applied })
          }
          continue
        }
      }

      if (!charge) {
        const userId = String(payload.userId || '')
        if (!userId) {
          results.push({ ok: false, error: 'Cobrança não encontrada e userId ausente', txid })
          continue
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
            provider: String(payload.provider || 'sicoob'),
            raw_payload: payload,
          })
          .select('*')
          .maybeSingle()

        if (error) {
          results.push({ ok: false, error: error.message, txid })
          continue
        }
        results.push({ ok: true, mode: 'orphan', payment: orphan })
        continue
      }

      if (charge.status === 'paid') {
        results.push({ ok: true, mode: 'already_paid', chargeId: charge.id })
        continue
      }

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
          provider: String(payload.provider || charge.provider || 'sicoob'),
          matched_sale_id: charge.sale_id,
          raw_payload: payload,
        })
        .select('*')
        .single()

      if (payError) {
        results.push({ ok: false, error: payError.message, txid })
        continue
      }

      const applyAmount = Math.min(Number(amount), Number(charge.amount))
      const { error: amortError } = await admin.rpc('amortize_sale_from_pix', {
        p_user_id: charge.user_id,
        p_sale_id: charge.sale_id,
        p_pix_payment_id: payment.id,
        p_amount: applyAmount,
        p_note: 'Baixa automática PIX',
        p_source: 'webhook',
      })

      if (amortError) {
        results.push({ ok: false, error: amortError.message, txid })
        continue
      }

      await admin
        .from('pix_charges')
        .update({ status: 'paid', paid_at: new Date().toISOString() })
        .eq('id', charge.id)

      results.push({
        ok: true,
        mode: 'auto_settled',
        chargeId: charge.id,
        saleId: charge.sale_id,
        paymentId: payment.id,
        amount: applyAmount,
      })
    }

    return json({ ok: true, results })
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Erro interno' }, 500)
  }
})
