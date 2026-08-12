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

function makeTxid() {
  const raw = crypto.randomUUID().replace(/-/g, '')
  return `rifa${raw}`.slice(0, 25)
}

function mockBrCode(amount: number, txid: string) {
  // Placeholder EMV-like payload for demo/QR rendering in UI.
  return `00020126580014BR.GOV.BCB.PIX0136${txid}520400005303986540${amount.toFixed(2)}5802BR5925RIFAPIX DEMO6009SAO PAULO62070503***6304ABCD`
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

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    })
    const admin = createClient(supabaseUrl, serviceKey)

    const {
      data: { user },
      error: userError,
    } = await userClient.auth.getUser()
    if (userError || !user) return json({ error: 'Unauthorized' }, 401)

    const body = await req.json()
    const saleId = String(body.saleId || '')
    if (!saleId) return json({ error: 'saleId obrigatório' }, 400)

    const { data: sale, error: saleError } = await admin
      .from('sales')
      .select('*')
      .eq('id', saleId)
      .eq('user_id', user.id)
      .single()

    if (saleError || !sale) return json({ error: 'Venda não encontrada' }, 404)

    const open = Number(sale.total_amount) - Number(sale.paid_amount)
    if (open <= 0.009) return json({ error: 'Venda já quitada' }, 400)

    const amount = Number(body.amount ?? open)
    if (!(amount > 0) || amount > open + 0.009) {
      return json({ error: 'Valor de cobrança inválido' }, 400)
    }

    const txid = makeTxid()
    const copyPaste = mockBrCode(amount, txid)
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString()

    // Provider hook: if EFI/ASAAS secrets exist, create real charge here.
    const provider = Deno.env.get('PIX_PROVIDER') || 'mock'

    const { data: charge, error: chargeError } = await admin
      .from('pix_charges')
      .insert({
        user_id: user.id,
        sale_id: saleId,
        txid,
        amount,
        status: 'pending',
        copy_paste: copyPaste,
        qr_code: copyPaste,
        provider,
        expires_at: expiresAt,
      })
      .select('*')
      .single()

    if (chargeError) return json({ error: chargeError.message }, 400)

    return json({ charge })
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Erro interno' }, 500)
  }
})
