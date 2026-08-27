const AUTH_KEY = 'rifa-pix-auth-v1'
const SESSION_KEY = 'rifa-pix-session-v2'

export type AuthRecord = {
  organizerName: string
  salt: string
  hash: string
  iterations: number
  createdAt: string
}

export type SessionRecord = {
  token: string
  expiresAt: number
  role: 'admin' | 'member'
  memberId?: string
  memberName?: string
}

function toBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

function fromBase64(value: string) {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

async function deriveHash(password: string, saltB64: string, iterations: number) {
  const enc = new TextEncoder()
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: fromBase64(saltB64),
      iterations,
    },
    keyMaterial,
    256,
  )
  return toBase64(bits)
}

export function getAuthRecord(): AuthRecord | null {
  const raw = localStorage.getItem(AUTH_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as AuthRecord
  } catch {
    return null
  }
}

export function hasPasswordSetup() {
  return Boolean(getAuthRecord())
}

export async function setupPassword(organizerName: string, password: string) {
  if (password.length < 4) throw new Error('Senha deve ter pelo menos 4 caracteres.')
  const saltBytes = crypto.getRandomValues(new Uint8Array(16))
  const salt = toBase64(saltBytes.buffer)
  const iterations = 120_000
  const hash = await deriveHash(password, salt, iterations)
  const record: AuthRecord = {
    organizerName: organizerName.trim() || 'Organizador',
    salt,
    hash,
    iterations,
    createdAt: new Date().toISOString(),
  }
  localStorage.setItem(AUTH_KEY, JSON.stringify(record))
  await createAdminSession()
  return record
}

export async function loginAdmin(password: string) {
  const record = getAuthRecord()
  if (!record) throw new Error('Senha ainda não configurada.')
  const hash = await deriveHash(password, record.salt, record.iterations)
  if (hash !== record.hash) throw new Error('Senha incorreta.')
  await createAdminSession()
}

/** Confirma senha do ADM sem criar nova sessão (ações sensíveis). */
export async function verifyAdminPassword(password: string) {
  const record = getAuthRecord()
  if (!record) {
    if (password.trim().toUpperCase() === 'CONFIRMAR') return
    throw new Error('Senha do ADM não configurada neste aparelho. Digite CONFIRMAR ou configure a senha no primeiro acesso.')
  }
  if (!password.trim()) throw new Error('Informe a senha do ADM.')
  const hash = await deriveHash(password, record.salt, record.iterations)
  if (hash !== record.hash) throw new Error('Senha incorreta.')
}

function writeSession(session: SessionRecord) {
  const raw = JSON.stringify(session)
  sessionStorage.setItem(SESSION_KEY, raw)
  localStorage.setItem(SESSION_KEY, raw)
}

async function createAdminSession(organizerName?: string) {
  const tokenBytes = crypto.getRandomValues(new Uint8Array(24))
  const session: SessionRecord = {
    token: toBase64(tokenBytes.buffer),
    expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
    role: 'admin',
    memberName: organizerName,
  }
  writeSession(session)
}

/** Sessão ADM sem senha local (modo Supabase). */
export async function loginAdminSession(organizerName?: string) {
  await createAdminSession(organizerName)
}

export function loginMemberSession(memberId: string, memberName: string) {
  const tokenBytes = crypto.getRandomValues(new Uint8Array(24))
  const session: SessionRecord = {
    token: toBase64(tokenBytes.buffer),
    expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
    role: 'member',
    memberId,
    memberName,
  }
  writeSession(session)
}

export function loginMember(memberId: string, memberName: string, pin: string, expectedPin: string) {
  if (pin.trim() !== expectedPin.trim()) throw new Error('PIN incorreto.')
  loginMemberSession(memberId, memberName)
}

export function logout() {
  sessionStorage.removeItem(SESSION_KEY)
  localStorage.removeItem(SESSION_KEY)
}

export function getSession(): SessionRecord | null {
  const raw = sessionStorage.getItem(SESSION_KEY) || localStorage.getItem(SESSION_KEY)
  if (!raw) return null
  try {
    const session = JSON.parse(raw) as SessionRecord
    if (Date.now() > session.expiresAt) {
      logout()
      return null
    }
    sessionStorage.setItem(SESSION_KEY, raw)
    return session
  } catch {
    return null
  }
}

export function isAuthenticated() {
  return Boolean(getSession())
}

/** Compat: login antigo = admin */
export async function login(password: string) {
  return loginAdmin(password)
}

export async function changePassword(currentPassword: string, nextPassword: string) {
  await loginAdmin(currentPassword)
  const record = getAuthRecord()
  if (!record) throw new Error('Conta não encontrada.')
  await setupPassword(record.organizerName, nextPassword)
}
