import { supabaseUrl } from './supabase'

async function tryFetch(url: string, cors: RequestMode, ms: number): Promise<boolean> {
  const ctrl = new AbortController()
  const t = window.setTimeout(() => ctrl.abort(), ms)
  try {
    const res = await fetch(url, {
      method: 'GET',
      cache: 'no-store',
      mode: cors,
      signal: ctrl.signal,
    })
    if (cors === 'no-cors') return true
    return res.ok || res.status < 500
  } catch {
    return false
  } finally {
    window.clearTimeout(t)
  }
}

/**
 * Ping real de internet — não usa o cliente Supabase (no iPhone ele fica
 * “morto” depois de um tempo sem rede e o setInterval também congela).
 */
export async function pingNetwork(): Promise<boolean> {
  const targets: Array<{ url: string; mode: RequestMode }> = []
  if (supabaseUrl) {
    targets.push({ url: `${supabaseUrl}/auth/v1/health`, mode: 'cors' })
  }
  targets.push({ url: 'https://www.gstatic.com/generate_204', mode: 'no-cors' })
  const results = await Promise.all(targets.map((t) => tryFetch(t.url, t.mode, 4_000)))
  return results.some(Boolean)
}
