/**
 * Cliente PIX Sicoob (API Pix v2 + OAuth client_credentials + mTLS).
 * Secrets (Supabase):
 *   PIX_PROVIDER=sicoob
 *   SICOOB_CLIENT_ID=
 *   SICOOB_PIX_KEY=          (chave PIX da conta recebedora)
 *   SICOOB_CERT_PEM=         (certificado público .pem / .cer)
 *   SICOOB_KEY_PEM=          (chave privada .pem)
 *   SICOOB_ENV=homol|prod    (default homol)
 * Opcional homolog sem mTLS (raro): SICOOB_ACCESS_TOKEN=
 */

export type SicoobCobResult = {
  txid: string
  copyPaste: string
  qrCode: string
  status: string
  raw: unknown
}

function env(name: string, fallback = '') {
  return (Deno.env.get(name) || fallback).trim()
}

/**
 * Normaliza PEM vindo de secrets do Supabase.
 * Aceita: PEM puro, PEM com \n literais, ou Base64 do PEM inteiro.
 */
function normalizePem(raw: string, label: string): string {
  let s = (raw || '').trim().replace(/^\uFEFF/, '')
  if (!s) throw new Error(`${label} vazio`)

  // Base64 do arquivo PEM (recomendado no Windows)
  if (!s.includes('-----BEGIN') && /^[A-Za-z0-9+/=\r\n]+$/.test(s) && s.length > 80) {
    try {
      s = new TextDecoder().decode(
        Uint8Array.from(atob(s.replace(/\s+/g, '')), (c) => c.charCodeAt(0)),
      )
    } catch {
      /* segue como texto */
    }
  }

  // PowerShell / JSON às vezes grava \n como texto
  s = s.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\r\n/g, '\n')

  const start = s.indexOf('-----BEGIN')
  if (start < 0) {
    throw new Error(`${label}: sem bloco -----BEGIN (reenvie o secret; preferir Base64)`)
  }
  s = s.slice(start).trim()
  if (!s.includes('-----END')) {
    throw new Error(`${label}: PEM incompleto (sem -----END)`)
  }
  return s
}

/** Remove metadados PKCS#12 ("Bag Attributes") antes do bloco PEM. */
function extractPemBlock(pem: string): string {
  return normalizePem(pem, 'PEM')
}

function baseUrls() {
  const mode = (env('SICOOB_ENV', 'homol') || 'homol').toLowerCase()
  if (mode === 'prod' || mode === 'production') {
    const apiOverride = env('SICOOB_API_BASE')
    return {
      token: 'https://auth.sicoob.com.br/auth/realms/cooperado/protocol/openid-connect/token',
      // Host validado em producao (portal + teste local)
      api: apiOverride || 'https://api.sicoob.com.br/pix/api/v2',
      tokenAlt: 'https://auth.sicoob.com.br/auth/realms/cooperado/protocol/openid-connect/token',
      apiAlt: apiOverride || 'https://api.sicoob.com.br/pix/api/v2',
    }
  }
  return {
    token: 'https://auth.sicoob.com.br/auth/realms/cooperado/protocol/openid-connect/token',
    api: 'https://sandbox.sicoob.com.br/sicoob/sandbox/pix/api/v2',
    tokenAlt: 'https://auth.sicoob.com.br/auth/realms/cooperado/protocol/openid-connect/token',
    apiAlt: 'https://api-homol.sicoob.com.br/cooperado/pix/api/v2',
  }
}

let cachedClient: Deno.HttpClient | null = null

function assertMtlsReady() {
  if (cachedClient) return cachedClient
  const cert = normalizePem(env('SICOOB_CERT_PEM'), 'SICOOB_CERT_PEM')
  const key = normalizePem(env('SICOOB_KEY_PEM'), 'SICOOB_KEY_PEM')
  const create = (Deno as any).createHttpClient as
    | ((opts: { cert: string; key: string }) => Deno.HttpClient)
    | undefined
  if (!create) throw new Error('Runtime sem suporte a mTLS (createHttpClient)')
  try {
    cachedClient = create({ cert, key })
    return cachedClient
  } catch (e) {
    const hint = ' Reenvie secrets em Base64: .\\scripts\\set-sicoob-secrets.ps1'
    throw new Error(`Certificado mTLS inválido: ${e instanceof Error ? e.message : String(e)}.${hint}`)
  }
}

async function fetchWithMtls(url: string, init: RequestInit = {}) {
  const client = assertMtlsReady()
  // deno-lint-ignore no-explicit-any
  return await fetch(url, { ...init, client } as any)
}

export async function sicoobGetToken(): Promise<string> {
  const manual = env('SICOOB_ACCESS_TOKEN')
  if (manual) return manual

  const clientId = env('SICOOB_CLIENT_ID')
  if (!clientId) throw new Error('SICOOB_CLIENT_ID ausente nos secrets')

  const { token, tokenAlt } = baseUrls()
  const body = new URLSearchParams()
  body.set('grant_type', 'client_credentials')
  body.set('client_id', clientId)
  body.set('scope', 'cob.write cob.read pix.read webhook.write webhook.read')

  const secret = env('SICOOB_CLIENT_SECRET')
  if (secret) body.set('client_secret', secret)

  const tryUrls = [token, tokenAlt]
  let lastErr = 'falha no token Sicoob'
  for (const url of tryUrls) {
    try {
      const res = await fetchWithMtls(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok && data.access_token) return String(data.access_token)
      lastErr = `[${url}] token ${res.status}: ${JSON.stringify(data).slice(0, 300)}`
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      lastErr = `[${url}] ${msg}`
      // HandshakeFailure = certificado errado — não adianta tentar outro host
      if (/HandshakeFailure|certificate|certificado|mTLS/i.test(msg)) break
    }
  }
  throw new Error(lastErr)
}

export async function sicoobCreateCob(opts: {
  txid: string
  amount: number
  description?: string
  /** Texto que aparece nas observações do comprovante do pagador (máx. 140) */
  payerNote?: string
  /** Campos extras no extrato/comprovante (Bacen infoAdicionais) */
  extraInfo?: Array<{ nome: string; valor: string }>
  expiresSeconds?: number
}): Promise<SicoobCobResult> {
  const clientId = env('SICOOB_CLIENT_ID')
  const chave = env('SICOOB_PIX_KEY')
  if (!chave) throw new Error('SICOOB_PIX_KEY ausente (chave PIX da conta)')

  const accessToken = await sicoobGetToken()
  const { api, apiAlt } = baseUrls()
  const expires = opts.expiresSeconds ?? 1800
  const note = (opts.payerNote || opts.description || 'RifaPIX').slice(0, 140)
  const payload: Record<string, unknown> = {
    calendario: { expiracao: expires },
    valor: { original: opts.amount.toFixed(2) },
    chave,
    solicitacaoPagador: note,
  }
  if (opts.extraInfo?.length) {
    payload.infoAdicionais = opts.extraInfo
      .filter((x) => x.nome?.trim() && x.valor?.trim())
      .slice(0, 5)
      .map((x) => ({
        nome: x.nome.trim().slice(0, 50),
        valor: x.valor.trim().slice(0, 200),
      }))
  }

  // Somente hosts oficiais do portal/manual — sisbr costuma resetar conexao na Edge
  const tryApis = [api, apiAlt].filter((u, i, arr) => arr.indexOf(u) === i)
  let lastErr = 'falha ao criar cob Sicoob'
  for (const base of tryApis) {
    const url = `${base}/cob/${encodeURIComponent(opts.txid)}`
    try {
      const res = await fetchWithMtls(url, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          client_id: clientId,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(payload),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        lastErr = `[${base}] cob ${res.status}: ${JSON.stringify(data).slice(0, 400)}`
        continue
      }
      const copyPaste = String(
        data.brcode || data.pixCopiaECola || data.qrcode || data.qrCode || '',
      )
      if (!copyPaste) {
        lastErr = `[${base}] cob OK mas sem pixCopiaECola`
        continue
      }
      return {
        txid: String(data.txid || opts.txid),
        copyPaste,
        qrCode: copyPaste,
        status: String(data.status || 'ATIVA'),
        raw: data,
      }
    } catch (e) {
      lastErr = `[${base}] ${e instanceof Error ? e.message : String(e)}`
    }
  }
  throw new Error(lastErr)
}

/** Consulta cob no Sicoob (status ATIVA | CONCLUIDA | ...). */
export async function sicoobGetCob(txid: string): Promise<Record<string, unknown>> {
  const clientId = env('SICOOB_CLIENT_ID')
  const accessToken = await sicoobGetToken()
  const { api, apiAlt } = baseUrls()
  const tryApis = [api, apiAlt].filter((u, i, arr) => arr.indexOf(u) === i)
  let lastErr = 'falha ao consultar cob'
  for (const base of tryApis) {
    const url = `${base}/cob/${encodeURIComponent(txid)}`
    try {
      const res = await fetchWithMtls(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          client_id: clientId,
          Accept: 'application/json',
        },
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        lastErr = `[${base}] get cob ${res.status}: ${JSON.stringify(data).slice(0, 300)}`
        continue
      }
      return data as Record<string, unknown>
    } catch (e) {
      lastErr = `[${base}] ${e instanceof Error ? e.message : String(e)}`
    }
  }
  throw new Error(lastErr)
}

/** Normaliza webhook Bacen/Sicoob { pix: [...] } para itens flat. */
export function normalizeSicoobWebhook(payload: Record<string, unknown>) {
  const items: Array<{
    txid: string
    endToEndId: string
    amount: number
    paidAt: string
    payerName: string
  }> = []

  const pixArr = Array.isArray(payload.pix) ? payload.pix : null
  if (pixArr) {
    for (const raw of pixArr) {
      const p = raw as Record<string, unknown>
      const pagador = (p.pagador || {}) as Record<string, unknown>
      items.push({
        txid: String(p.txid || ''),
        endToEndId: String(p.endToEndId || p.e2eid || ''),
        amount: Number(p.valor || 0),
        paidAt: String(p.horario || new Date().toISOString()),
        payerName: String(pagador.nome || p.pagador || 'Pagador PIX'),
      })
    }
    return items
  }

  // formato flat já usado pelo mock
  items.push({
    txid: String(payload.txid || payload.txId || ''),
    endToEndId: String(payload.endToEndId || payload.e2e || ''),
    amount: Number(payload.amount || payload.valor || 0),
    paidAt: String(payload.paidAt || payload.horario || new Date().toISOString()),
    payerName: String(payload.payerName || payload.pagador || 'Pagador PIX'),
  })
  return items
}
