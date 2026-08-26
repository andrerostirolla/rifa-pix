import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1'
import { sicoobGetCob } from '../_shared/sicoob.ts'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
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
    const body = await req.json()
    const accessCode = String(body.accessCode || '').trim()
    const memberId = String(body.memberId || '').trim()
    const pin = String(body.pin || '').trim()
    const txid = String(body.txid || '').trim()

    if (!accessCode || !memberId || !pin) return json({ error: 'Código, membro e PIN obrigatórios' }, 400)
    if (!txid) return json({ error: 'txid obrigatório' }, 400)

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const admin = createClient(supabaseUrl, serviceKey)

    const { data: workspaceId, error: verifyErr } = await admin.rpc('verify_workspace_member_pin', {
      p_code: accessCode,
      p_member_id: memberId,
      p_pin: pin,
    })
    if (verifyErr) return json({ error: verifyErr.message }, 401)

    const { data: wsCharge, error: chErr } = await admin
      .from('workspace_pix_charges')
      .select('*')
      .eq('workspace_id', workspaceId)
      .eq('txid', txid)
      .maybeSingle()

    if (chErr) return json({ error: chErr.message }, 400)
    if (!wsCharge) return json({ error: 'Cobrança não encontrada para este TXID' }, 404)

    if (wsCharge.status === 'paid') {
      return json({
        ok: true,
        status: 'paid',
        mode: 'already_paid',
        saleId: wsCharge.workspace_sale_id,
        amount: Number(wsCharge.amount),
      })
    }

    const cob = await sicoobGetCob(txid)
    const status = String(cob.status || '').toUpperCase()
    const pixArr = Array.isArray(cob.pix) ? cob.pix : []
    const paidHint =
      status === 'CONCLUIDA' ||
      pixArr.length > 0 ||
      Number((cob.valor as { original?: string })?.original || 0) > 0 && status === 'CONCLUIDA'

    if (!paidHint && status !== 'CONCLUIDA') {
      return json({
        ok: true,
        status: status || 'ATIVA',
        mode: 'pending',
        message: 'Ainda não consta pagamento no Sicoob. Aguarde alguns segundos e tente de novo.',
        saleId: wsCharge.workspace_sale_id,
      })
    }

    const amount = Number(
      (pixArr[0] as { valor?: string } | undefined)?.valor ||
        wsCharge.amount ||
        (cob.valor as { original?: string })?.original ||
        0,
    )

    const { data: applied, error: applyErr } = await admin.rpc('apply_workspace_pix_payment', {
      p_workspace_id: workspaceId,
      p_txid: txid,
      p_amount: amount > 0 ? amount : Number(wsCharge.amount),
      p_paid_at: new Date().toISOString(),
    })

    if (applyErr) return json({ error: applyErr.message }, 400)

    return json({
      ok: true,
      status: 'paid',
      mode: 'settled',
      saleId: wsCharge.workspace_sale_id,
      amount: amount > 0 ? amount : Number(wsCharge.amount),
      applied,
      cobStatus: status,
    })
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Erro interno' }, 500)
  }
})
