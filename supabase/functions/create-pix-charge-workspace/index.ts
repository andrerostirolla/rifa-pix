import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1'
import { sicoobCreateCob } from '../_shared/sicoob.ts'
import { buildMockPixCopiaECola } from '../_shared/emv.ts'

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

function makeTxid() {
  // Bacen cob dinamica: txid [a-zA-Z0-9]{26,35}
  const raw = crypto.randomUUID().replace(/-/g, '')
  return `rifa${raw}`.slice(0, 32)
}

function mockBrCode(amount: number, txid: string) {
  const pixKey = (Deno.env.get('SICOOB_PIX_KEY') || '').trim() || '00000000000'
  return buildMockPixCopiaECola(amount, txid, pixKey)
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  try {
    const body = await req.json()
    const accessCode = String(body.accessCode || '').trim()
    const memberId = String(body.memberId || '').trim()
    const pin = String(body.pin || '').trim()
    const saleId = String(body.saleId || '').trim()
    const amount = Number(body.amount)

    if (!accessCode || !memberId || !pin) return json({ error: 'Código, membro e PIN obrigatórios' }, 400)
    if (!saleId) return json({ error: 'saleId obrigatório' }, 400)
    if (!(amount > 0)) return json({ error: 'Valor inválido' }, 400)

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const admin = createClient(supabaseUrl, serviceKey)

    const { data: workspaceId, error: verifyErr } = await admin.rpc('verify_workspace_member_pin', {
      p_code: accessCode,
      p_member_id: memberId,
      p_pin: pin,
    })
    if (verifyErr) {
      const msg = verifyErr.message || ''
      if (msg.includes('verify_workspace_member_pin') || msg.includes('does not exist')) {
        return json({
          error: 'Migration pendente: rode supabase/migrations/20260825000000_workspace_pix_charges.sql no SQL Editor',
        }, 503)
      }
      return json({ error: verifyErr.message }, 401)
    }

    const { data: wsRow, error: wsErr } = await admin
      .from('workspaces')
      .select('state')
      .eq('id', workspaceId)
      .single()
    if (wsErr || !wsRow) return json({ error: 'Workspace não encontrado' }, 404)

    const state = (wsRow.state || {}) as Record<string, unknown>
    const sales = Array.isArray(state.sales) ? state.sales as Array<Record<string, unknown>> : []
    let sale = sales.find((s) => String(s.id) === saleId)

    if (!sale && body.sale && typeof body.sale === 'object') {
      const fromBody = body.sale as Record<string, unknown>
      if (String(fromBody.id) === saleId && String(fromBody.memberId) === memberId) {
        sale = fromBody
      }
    }

    if (!sale) return json({ error: 'Venda não encontrada no workspace (sincronize e tente de novo)' }, 404)

    if (String(sale.paymentMethod) !== 'pix') {
      return json({ error: 'Venda não é PIX' }, 400)
    }
    if (String(sale.pixDestination || 'entidade') !== 'entidade') {
      return json({ error: 'PIX deve ser na conta da loja' }, 400)
    }

    const open = Number(sale.totalAmount) - Number(sale.paidAmount || 0)
    if (open <= 0.009) return json({ error: 'Venda já quitada' }, 400)
    if (amount > open + 0.009) return json({ error: 'Valor acima do em aberto' }, 400)

    const txid = makeTxid()
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString()
    const provider = (Deno.env.get('PIX_PROVIDER') || 'mock').toLowerCase()

    const buyer = String(sale.buyerName || body.buyerName || 'Comprador').trim()
    const raffles = Array.isArray(state.raffles) ? (state.raffles as Array<Record<string, unknown>>) : []
    const raffle = raffles.find((r) => String(r.id) === String(sale.raffleId || ''))
    const eventLabel = String(raffle?.eventName || raffle?.name || '').trim()
    const raffleLabel = String(raffle?.name || '').trim()
    // Observação no comprovante do pagador (aparece no app do banco)
    const payerNote = [
      'RifaPIX',
      eventLabel || raffleLabel || null,
      buyer ? `p/${buyer}` : null,
    ]
      .filter(Boolean)
      .join(' · ')
      .slice(0, 140)

    let copyPaste = mockBrCode(amount, txid)
    if (provider === 'sicoob') {
      try {
        const cob = await sicoobCreateCob({
          txid,
          amount,
          payerNote,
          description: payerNote,
          extraInfo: [
            { nome: 'Destino', valor: 'RifaPIX' },
            ...(eventLabel ? [{ nome: 'Evento', valor: eventLabel }] : []),
            ...(raffleLabel && raffleLabel !== eventLabel
              ? [{ nome: 'Rifa', valor: raffleLabel }]
              : []),
            { nome: 'Comprador', valor: buyer },
          ],
          expiresSeconds: 1800,
        })
        copyPaste = cob.copyPaste
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return json({ error: `Sicoob: ${msg}` }, 502)
      }
    }

    const { data: charge, error: insErr } = await admin
      .from('workspace_pix_charges')
      .insert({
        workspace_id: workspaceId,
        workspace_sale_id: saleId,
        member_id: memberId,
        txid,
        amount,
        status: 'pending',
        copy_paste: copyPaste,
        provider,
        expires_at: expiresAt,
      })
      .select('*')
      .single()

    if (insErr) {
      const msg = insErr.message || ''
      if (msg.includes('workspace_pix_charges') && msg.includes('does not exist')) {
        return json({
          error: 'Tabela workspace_pix_charges ausente — rode a migration no SQL Editor do Supabase',
        }, 503)
      }
      return json({ error: insErr.message }, 400)
    }

    // Espelha a cobrança no JSON do workspace (aba TXID do ADM / sync)
    const pixCharges = Array.isArray(state.pixCharges)
      ? (state.pixCharges as Array<Record<string, unknown>>)
      : []
    const chargeRow = {
      id: charge.id,
      saleId,
      txid,
      amount,
      status: 'pending',
      createdAt: charge.created_at || new Date().toISOString(),
      copyPaste,
      qrCode: copyPaste,
      provider,
      expiresAt,
    }
    let nextSales = sales
    if (!sales.some((s) => String(s.id) === saleId) && sale) {
      nextSales = [sale, ...sales]
    }
    const nextCharges = [
      chargeRow,
      ...pixCharges.filter((c) => String(c.saleId) !== saleId || String(c.status) !== 'pending'),
    ]
    await admin
      .from('workspaces')
      .update({
        state: { ...state, sales: nextSales, pixCharges: nextCharges },
        updated_at: new Date().toISOString(),
      })
      .eq('id', workspaceId)

    return json({
      charge: {
        id: charge.id,
        saleId,
        txid,
        amount,
        copyPaste,
        qrCode: copyPaste,
        status: 'pending',
        expiresAt,
        provider,
      },
    })
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Erro interno' }, 500)
  }
})
