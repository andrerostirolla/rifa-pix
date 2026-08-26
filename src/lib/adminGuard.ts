import { getAuthRecord, verifyAdminPassword } from '../auth'
import { formatErr, translateAuthErr } from './errors'
import { isSupabaseConfigured, supabase } from './supabase'

/**
 * Confirma que quem está na frente da tela é o ADM.
 *
 * Em modo nuvem o ADM entra com e-mail/senha do Supabase e normalmente não tem
 * senha local (PBKDF2). Por isso a validação tenta, nesta ordem:
 * 1. senha local, quando existe neste aparelho;
 * 2. senha da conta Supabase do ADM logado;
 * 3. a palavra CONFIRMAR, só quando não há nenhuma das duas.
 */
export async function verifyAdminCredential(password: string) {
  const pwd = password.trim()
  if (!pwd) throw new Error('Informe a senha do ADM.')

  if (getAuthRecord()) {
    await verifyAdminPassword(pwd)
    return
  }

  if (isSupabaseConfigured && supabase) {
    const { data } = await supabase.auth.getUser()
    const email = data.user?.email
    if (email) {
      const { error } = await supabase.auth.signInWithPassword({ email, password: pwd })
      if (error) {
        const msg = translateAuthErr(formatErr(error))
        throw new Error(/incorret|credential/i.test(msg) ? 'Senha do ADM incorreta.' : msg)
      }
      return
    }
  }

  if (pwd.toUpperCase() === 'CONFIRMAR') return
  throw new Error('Senha do ADM não configurada neste aparelho. Digite CONFIRMAR para seguir.')
}

/** Texto de ajuda do campo, coerente com o método que será validado. */
export function adminCredentialHint() {
  if (getAuthRecord()) return 'Senha do ADM deste aparelho.'
  if (isSupabaseConfigured && supabase) return 'Senha da conta de Administrador (a mesma do login).'
  return 'Sem senha configurada — digite CONFIRMAR.'
}
