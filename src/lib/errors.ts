/** Extrai mensagem de AuthError / PostgrestError / string / objeto. */
export function formatErr(err: unknown, fallback = 'Falha na autenticação.') {
  if (!err) return fallback
  if (typeof err === 'string' && err.trim()) return err
  if (err instanceof Error && err.message.trim()) return err.message
  if (typeof err === 'object') {
    const o = err as { message?: unknown; error_description?: unknown; error?: unknown; msg?: unknown }
    for (const v of [o.message, o.error_description, o.msg, o.error]) {
      if (typeof v === 'string' && v.trim()) return v
    }
  }
  try {
    const s = JSON.stringify(err)
    if (s && s !== '{}') return s.slice(0, 240)
  } catch {
    /* ignore */
  }
  return fallback
}

export function translateAuthErr(msg: string) {
  if (/invalid login credentials|invalid_credentials/i.test(msg)) {
    return 'E-mail ou senha incorretos.'
  }
  if (/email not confirmed/i.test(msg)) {
    return 'Confirme o e-mail no link que o Supabase enviou (ou desative “Confirm email” no Auth).'
  }
  if (/invalid path/i.test(msg)) {
    return 'URL do Auth inválida. Em Authentication → URL Configuration, Site URL = https://andrerostirolla.github.io/rifa-pix/'
  }
  if (/already registered|user already/i.test(msg)) {
    return 'Este e-mail já tem conta. Use Entrar (Já tenho conta).'
  }
  if (/ensure_my_workspace|does not exist/i.test(msg)) {
    return 'Migration pendente no Supabase: rode supabase/migrations/20260826140000_workspace_admins_audit.sql no SQL Editor.'
  }
  if (/Não autenticado|not authenticated|JWT/i.test(msg)) {
    return 'Sessão inválida. Saia e entre de novo.'
  }
  return msg
}

/** Falha típica de aparelho sem internet (não é erro de login/PIN). */
export function isNetworkError(err: unknown) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true
  const msg = formatErr(err, '')
  return /rede|internet|Sem resposta|Tempo esgotado|network|fetch|Failed to fetch|conex|offline|ERR_INTERNET|timed out/i.test(
    msg,
  )
}
