/** Desbloqueio local com Face ID / biometria (WebAuthn) + credenciais salvas no aparelho. */

const BIO_KEY = 'rifa-pix-bio-unlock-v1'

export type BioUnlockRecord = {
  credentialId: string
  role: 'member'
  workspaceCode: string
  memberId: string
  memberName: string
  pin: string
  createdAt: string
}

function toBase64Url(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function fromBase64Url(value: string) {
  const pad = value.length % 4 === 0 ? '' : '='.repeat(4 - (value.length % 4))
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/') + pad
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

export function biometricsSupported() {
  return typeof window !== 'undefined' && Boolean(window.PublicKeyCredential)
}

export function loadBioUnlock(): BioUnlockRecord | null {
  try {
    const raw = localStorage.getItem(BIO_KEY)
    return raw ? (JSON.parse(raw) as BioUnlockRecord) : null
  } catch {
    return null
  }
}

export function clearBioUnlock() {
  localStorage.removeItem(BIO_KEY)
}

export async function registerMemberBiometrics(input: {
  workspaceCode: string
  memberId: string
  memberName: string
  pin: string
}): Promise<BioUnlockRecord> {
  if (!biometricsSupported()) throw new Error('Este aparelho/navegador não suporta Face ID / biometria.')

  const cred = (await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: {
        name: 'RifaPIX',
        id: window.location.hostname,
      },
      user: {
        id: new TextEncoder().encode(`member:${input.memberId}`),
        name: `${input.memberName}@rifapix`,
        displayName: input.memberName,
      },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        userVerification: 'required',
        residentKey: 'preferred',
      },
      timeout: 60_000,
      attestation: 'none',
    },
  })) as PublicKeyCredential | null

  if (!cred) throw new Error('Não foi possível ativar a biometria.')

  const record: BioUnlockRecord = {
    credentialId: toBase64Url(cred.rawId),
    role: 'member',
    workspaceCode: input.workspaceCode.trim().toUpperCase(),
    memberId: input.memberId,
    memberName: input.memberName,
    pin: input.pin,
    createdAt: new Date().toISOString(),
  }
  localStorage.setItem(BIO_KEY, JSON.stringify(record))
  return record
}

export async function unlockWithBiometrics(): Promise<BioUnlockRecord> {
  const saved = loadBioUnlock()
  if (!saved) throw new Error('Face ID ainda não foi ativado neste aparelho.')
  if (!biometricsSupported()) throw new Error('Biometria indisponível neste navegador.')

  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rpId: window.location.hostname,
      allowCredentials: [
        {
          type: 'public-key',
          id: fromBase64Url(saved.credentialId),
          transports: ['internal'],
        },
      ],
      userVerification: 'required',
      timeout: 60_000,
    },
  })) as PublicKeyCredential | null

  if (!assertion) throw new Error('Biometria cancelada.')
  const id = toBase64Url(assertion.rawId)
  if (id !== saved.credentialId) throw new Error('Credencial biométrica não confere.')
  return saved
}
