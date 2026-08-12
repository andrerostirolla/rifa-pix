import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1'

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
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'Missing Authorization' }, 401)

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const webhookSecret = Deno.env.get('PIX_WEBHOOK_SECRET') || ''

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    })
    const {
      data: { user },
      error: userError,
    } = await userClient.auth.getUser()
    if (userError || !user) return json({ error: 'Unauthorized' }, 401)

    const body = await req.json()
    const chargeId = String(body.chargeId || '')
    if (!chargeId) return json({ error: 'chargeId obrigatório' }, 400)

    const admin = createClient(supabaseUrl, serviceKey)
    const { data: charge, error } = await admin
      .from('pix_charges')
      .select('*')
      .eq('id', chargeId)
      .eq('user_id', user.id)
      .single()

    if (error || !charge) return json({ error: 'Cobrança não encontrada' }, 404)
    if (charge.status === 'paid') return json({ ok: true, alreadyPaid: true })

    const webhookUrl = `${supabaseUrl}/functions/v1/pix-webhook`
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-webhook-secret': webhookSecret,
      },
      body: JSON.stringify({
        txid: charge.txid,
        amount: Number(charge.amount),
        payerName: body.payerName || 'Pagador Simulado',
        paidAt: new Date().toISOString(),
        provider: 'mock-simulate',
        userId: user.id,
      }),
    })

    const result = await res.json()
    return json(result, res.status)
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Erro interno' }, 500)
  }
})
