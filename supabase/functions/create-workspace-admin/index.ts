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
    const authHeader = req.headers.get('Authorization') || ''
    if (!authHeader.startsWith('Bearer ')) return json({ error: 'Não autenticado' }, 401)

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    })
    const admin = createClient(supabaseUrl, serviceKey)

    const { data: userData, error: userErr } = await userClient.auth.getUser()
    if (userErr || !userData.user) return json({ error: 'Sessão inválida' }, 401)
    const callerId = userData.user.id

    const body = await req.json()
    const displayName = String(body.displayName || '').trim()
    const email = String(body.email || '').trim().toLowerCase()
    const password = String(body.password || '')
    const workspaceId = String(body.workspaceId || '').trim()

    if (!displayName) return json({ error: 'Informe o nome/apelido' }, 400)
    if (!email || !email.includes('@')) return json({ error: 'E-mail inválido' }, 400)
    if (password.length < 6) return json({ error: 'Senha mínimo 6 caracteres' }, 400)
    if (!workspaceId) return json({ error: 'workspaceId obrigatório' }, 400)

    const { data: ws, error: wsErr } = await admin
      .from('workspaces')
      .select('id, owner_id')
      .eq('id', workspaceId)
      .maybeSingle()
    if (wsErr || !ws) return json({ error: 'Workspace não encontrado' }, 404)
    if (ws.owner_id !== callerId) {
      return json({ error: 'Só o dono da equipe pode criar outros ADMs' }, 403)
    }

    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        organizer_name: displayName,
        display_name: displayName,
        must_change_password: true,
      },
    })
    if (createErr || !created.user) {
      return json({ error: createErr?.message || 'Falha ao criar usuário' }, 400)
    }

    const { error: linkErr } = await admin.from('workspace_admins').insert({
      workspace_id: workspaceId,
      user_id: created.user.id,
      display_name: displayName,
      role: 'admin',
      created_by: callerId,
    })
    if (linkErr) {
      await admin.auth.admin.deleteUser(created.user.id)
      return json({ error: linkErr.message }, 400)
    }

    await admin.from('workspace_audit_log').insert({
      workspace_id: workspaceId,
      actor_user_id: callerId,
      actor_name: String(userData.user.user_metadata?.display_name || userData.user.email || 'ADM'),
      action: 'admin.create',
      detail: { email, displayName, userId: created.user.id },
    })

    return json({
      ok: true,
      admin: {
        userId: created.user.id,
        email,
        displayName,
        role: 'admin',
      },
    })
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Erro interno' }, 500)
  }
})
