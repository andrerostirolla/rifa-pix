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
    const body = await req.json()
    const accessCode = String(body.accessCode || '').trim()
    if (!accessCode) return json({ error: 'accessCode obrigatório' }, 400)

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const admin = createClient(supabaseUrl, serviceKey)

    const { data, error } = await admin.rpc('list_workspace_pix_charges', { p_code: accessCode })
    if (error) {
      // Fallback direto na tabela se RPC ainda não aplicada
      const { data: ws, error: wsErr } = await admin
        .from('workspaces')
        .select('id')
        .ilike('access_code', accessCode)
        .maybeSingle()
      if (wsErr || !ws) return json({ error: error.message }, 400)

      const { data: rows, error: chErr } = await admin
        .from('workspace_pix_charges')
        .select('*')
        .eq('workspace_id', ws.id)
        .order('created_at', { ascending: false })
      if (chErr) return json({ error: chErr.message }, 400)

      return json({
        charges: (rows || []).map((r) => ({
          id: r.id,
          saleId: r.workspace_sale_id,
          memberId: r.member_id,
          txid: r.txid,
          amount: Number(r.amount),
          status: r.status,
          copyPaste: r.copy_paste,
          provider: r.provider,
          expiresAt: r.expires_at,
          paidAt: r.paid_at,
          createdAt: r.created_at,
        })),
      })
    }

    return json({ charges: data || [] })
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Erro interno' }, 500)
  }
})
