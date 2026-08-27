import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type { ParsedPixRow } from './csvImport'
import { makeLocalTxid, previewTxidMatches } from './txidMatch'
import { buildMockPixCopiaECola } from './lib/emvPix'
import type {
  AmortizationEntry,
  AppState,
  AuditEntry,
  Block,
  BlockTransfer,
  CashDestination,
  Member,
  MemberSettlement,
  NumberRange,
  PaymentStatus,
  PixCharge,
  PixDestination,
  PixPayment,
  Raffle,
  Sale,
} from './types'

function uid() {
  return crypto.randomUUID()
}

function saleStatus(total: number, paid: number): PaymentStatus {
  if (paid <= 0) return 'pendente'
  if (paid + 0.001 < total) return 'parcial'
  if (Math.abs(paid - total) < 0.01) return 'quitado'
  return 'divergente'
}

function overlaps(aFrom: number, aTo: number, bFrom: number, bTo: number) {
  return aFrom <= bTo && bFrom <= aTo
}

/** Teto do rastro de ações. Alto de propósito: o log não deve ser podado no dia a dia. */
const AUDIT_MAX = 5000

/** Une rastros de ações sem perder entrada de nenhum aparelho. */
function mergeAudit(remote: AuditEntry[] = [], local: AuditEntry[] = []): AuditEntry[] {
  const byId = new Map<string, AuditEntry>()
  for (const e of [...remote, ...local]) {
    if (e?.id) byId.set(e.id, e)
  }
  return [...byId.values()].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, AUDIT_MAX)
}

function pickSale(a: Sale, b: Sale): Sale {
  if (a.cancelledAt && !b.cancelledAt) return a
  if (b.cancelledAt && !a.cancelledAt) return b
  if (Boolean(a.cashSettledAt) !== Boolean(b.cashSettledAt)) return a.cashSettledAt ? a : b
  if ((a.paidAmount || 0) !== (b.paidAmount || 0)) return (a.paidAmount || 0) > (b.paidAmount || 0) ? a : b
  return a
}

/** Une vendas por id — contingência local não pode sumir num pull da nuvem. */
function mergeSales(remote: Sale[] = [], local: Sale[] = []): Sale[] {
  const byId = new Map<string, Sale>()
  for (const s of remote) if (s?.id) byId.set(s.id, s)
  for (const s of local) {
    if (!s?.id) continue
    const cur = byId.get(s.id)
    byId.set(s.id, cur ? pickSale(cur, s) : s)
  }
  return [...byId.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
}

function mergeCharges(remote: PixCharge[] = [], local: PixCharge[] = []): PixCharge[] {
  const byId = new Map<string, PixCharge>()
  for (const c of remote) if (c?.id) byId.set(c.id, c)
  for (const c of local) if (c?.id && !byId.has(c.id)) byId.set(c.id, c)
  return [...byId.values()]
}

const PENDING_SALES_KEY = 'rifa-pix-pending-sales-v1'

function loadPendingSales(): Sale[] {
  try {
    const raw = localStorage.getItem(PENDING_SALES_KEY)
    const list = raw ? (JSON.parse(raw) as Sale[]) : []
    return Array.isArray(list) ? list.filter((s) => s?.id) : []
  } catch {
    return []
  }
}

function savePendingSales(sales: Sale[]) {
  try {
    localStorage.setItem(PENDING_SALES_KEY, JSON.stringify(sales.slice(0, 300)))
  } catch {
    /* quota */
  }
}

function rememberPendingSale(sale: Sale) {
  const list = loadPendingSales().filter((s) => s.id !== sale.id)
  list.unshift(sale)
  savePendingSales(list)
}

export function clearPendingSalesPresentIn(cloudSales: Sale[]) {
  const ids = new Set((cloudSales || []).map((s) => s.id))
  savePendingSales(loadPendingSales().filter((s) => !ids.has(s.id)))
}

function parseNumbersMeta(raw?: string): number[] {
  if (!raw) return []
  return raw
    .split(/[^\d]+/)
    .map((x) => Number(x))
    .filter((n) => Number.isFinite(n) && n > 0)
}

function parseBrlMeta(raw?: string): number {
  if (!raw) return 0
  const t = raw.replace(/[R$\s.]/g, '').replace(',', '.')
  const n = Number(t)
  return Number.isFinite(n) ? n : 0
}

const SALE_AUDIT_ACTIONS = new Set(['venda.contingencia', 'venda.dinheiro', 'venda.pix'])

/** Recria venda que a auditoria registrou mas o snapshot da nuvem perdeu no sync. */
function salesFromAudit(
  audit: AuditEntry[],
  sales: Sale[],
  members: Member[],
  raffles: Raffle[],
): Sale[] {
  const haveId = new Set(sales.map((s) => s.id))
  const taken = new Set(sales.filter((s) => !s.cancelledAt).flatMap((s) => s.numbers))
  const extra: Sale[] = []
  for (const e of audit || []) {
    if (!SALE_AUDIT_ACTIONS.has(e.action)) continue
    const saleId = e.ref?.saleId
    if (saleId && haveId.has(saleId)) continue
    const nums = parseNumbersMeta(e.meta?.Números)
    if (!nums.length) continue
    if (nums.some((n) => taken.has(n))) continue
    const member =
      members.find((m) => m.name === e.meta?.Vendedor) || members.find((m) => m.name === e.actorName)
    const raffle = raffles.find((r) => r.eventName === e.meta?.Evento || r.name === e.meta?.Evento) || raffles[0]
    if (!member || !raffle) continue
    const amount = parseBrlMeta(e.meta?.Valor) || nums.length * raffle.ticketPrice
    const paymentMethod: Sale['paymentMethod'] =
      e.action === 'venda.pix' || /^pix/i.test(e.meta?.['Forma de pagamento'] || '') ? 'pix' : 'dinheiro'
    const paid = paymentMethod === 'dinheiro' || e.action === 'venda.pix' ? amount : 0
    const sale: Sale = {
      id: saleId || `audit-${e.id}`,
      raffleId: raffle.id,
      memberId: member.id,
      buyerName: e.meta?.Comprador || 'Comprador',
      numbers: nums,
      totalAmount: amount,
      paidAmount: paid,
      status: saleStatus(amount, paid),
      paymentMethod,
      pixDestination: paymentMethod === 'pix' ? 'entidade' : undefined,
      cashDestination: paymentMethod === 'dinheiro' ? 'vendedor' : undefined,
      notes: e.action === 'venda.contingencia' ? 'Recuperada da auditoria (contingência)' : undefined,
      soldOffline: e.action === 'venda.contingencia' || undefined,
      createdAt: e.at,
    }
    extra.push(sale)
    haveId.add(sale.id)
    nums.forEach((n) => taken.add(n))
  }
  return extra
}

/** Texto único do cancelamento, usado na lista do membro, em Vendas e na tela TXID. */
export function cancelInfo(sale?: Sale | null, charge?: PixCharge | null) {
  if (!sale?.cancelledAt) return null
  const byMember = sale.cancelReason === 'membro'
  const minutes = (() => {
    if (!charge?.expiresAt || !charge.createdAt) return null
    const mins = Math.round(
      (new Date(charge.expiresAt).getTime() - new Date(charge.createdAt).getTime()) / 60000,
    )
    return Number.isFinite(mins) && mins > 0 ? mins : null
  })()
  return {
    byMember,
    label: byMember ? 'Cancelado por membro' : 'Pagamento expirado',
    at: sale.cancelledAt,
    who: byMember ? sale.cancelledBy || null : null,
    reason: byMember
      ? sale.cancelNote?.trim() || 'O vendedor cancelou sem informar o motivo.'
      : `Tempo limite do PIX venceu sem pagamento${minutes ? ` (QR de ${minutes} min)` : ''}. Os números voltaram a ficar livres.`,
  }
}

/** Validade padrão quando o provedor não devolve expiração. */
export const PIX_FALLBACK_TTL_MS = 30 * 60 * 1000

/** Momento (ms) em que o QR perde a validade, ou null se não houver como saber. */
export function pixChargeExpiryMs(charge: {
  expiresAt?: string
  createdAt?: string
}): number | null {
  if (charge.expiresAt) {
    const ms = new Date(charge.expiresAt).getTime()
    if (Number.isFinite(ms)) return ms
  }
  if (charge.createdAt) {
    const ms = new Date(charge.createdAt).getTime()
    if (Number.isFinite(ms)) return ms + PIX_FALLBACK_TTL_MS
  }
  return null
}

/** QR ainda aceita pagamento? */
export function isPixChargeExpired(charge?: {
  status: string
  expiresAt?: string
  createdAt?: string
}) {
  if (!charge) return false
  if (charge.status === 'expired' || charge.status === 'cancelled') return true
  if (charge.status !== 'pending') return false
  const expMs = pixChargeExpiryMs(charge)
  return expMs != null && expMs < Date.now()
}

type Store = AppState & {
  addRaffle: (input: {
    name: string
    eventName: string
    ticketPrice: number
    prize: string
    blockCount: number
    numbersPerBlock: number
    startDate?: string
    drawDate?: string
    active?: boolean
  }) => { ok: true; raffle: Raffle } | { ok: false; error: string }
  removeRaffle: (id: string) => void
  addMember: (input: { name: string; phone?: string; pin: string }) => { ok: true; member: Member } | { ok: false; error: string }
  updateMember: (id: string, patch: Partial<Pick<Member, 'name' | 'phone' | 'pin' | 'active'>>) => void
  removeMember: (id: string) => void
  /** Atribui bloco livre a um membro (não transfere entre membros). */
  assignBlock: (blockId: string, memberId: string) => { ok: boolean; error?: string }
  /** Transfere bloco de um membro para outro (com rastro). */
  transferBlock: (blockId: string, toMemberId: string) => { ok: boolean; error?: string }
  unassignBlock: (blockId: string) => void
  assignRange: (input: { memberId: string; raffleId: string; fromNumber: number; toNumber: number }) => {
    ok: boolean
    error?: string
  }
  removeRange: (id: string) => void
  memberNumbers: (memberId: string, raffleId: string, blockId?: string) => number[]
  blockNumbers: (blockId: string) => number[]
  soldNumbers: (raffleId: string) => Set<number>
  blockStats: (blockId: string) => { total: number; sold: number; open: number }
  memberBlockStats: (memberId: string, raffleId?: string) => {
    blocks: number
    openBlocks: number
    soldOutBlocks: number
    openNumbers: number
    soldNumbers: number
  }
  addSale: (input: {
    raffleId: string
    memberId: string
    buyerName: string
    buyerPhone?: string
    numbers: number[]
    paymentMethod: 'pix' | 'dinheiro'
    pixDestination?: PixDestination
    cashDestination?: CashDestination
    notes?: string
    soldOffline?: boolean
    proofTxid?: string
    proofImageDataUrl?: string
    proofPath?: string
    receivedNow?: boolean
    blockId?: string
  }) => { ok: true; sale: Sale } | { ok: false; error: string }
  patchSale: (
    id: string,
    patch: Partial<Pick<Sale, 'proofPath' | 'proofImageDataUrl' | 'notes' | 'paidAmount' | 'status'>>,
  ) => void
  removeSale: (id: string) => void
  addPix: (input: {
    amount: number
    paidAt: string
    payerName: string
    txid?: string
    endToEndId?: string
    notes?: string
  }) => void
  addPixBulk: (
    inputs: Array<{
      amount: number
      paidAt: string
      payerName: string
      txid?: string
      endToEndId?: string
      notes?: string
    }>,
  ) => { imported: number; skipped: number }
  importCsvAndSettleByTxid: (rows: ParsedPixRow[]) => {
    imported: number
    skipped: number
    settled: number
    unmatchedWithTxid: number
  }
  createChargeForSale: (saleId: string, amount?: number) => { ok: true; charge: PixCharge } | { ok: false; error: string }
  registerPixCharge: (input: {
    saleId: string
    txid: string
    amount: number
    copyPaste?: string
    qrCode?: string
    id?: string
    provider?: string
    expiresAt?: string
  }) => { ok: true; charge: PixCharge } | { ok: false; error: string }
  settlePixChargeByTxid: (
    txid: string,
    amount?: number,
    saleId?: string,
  ) => { ok: true; saleId: string; reactivated: boolean } | { ok: false; error: string }
  /** PIX pendente com QR vencido: cancela a venda e libera os números. */
  expireStalePixCharges: () => string[]
  /** Cancela um PIX em aberto mantendo o histórico e liberando os números. */
  cancelPixSale: (
    saleId: string,
    reason: 'expirado' | 'membro',
    info?: { note?: string; by?: string },
  ) => { ok: true; numbers: number[] } | { ok: false; error: string }
  attachTxidToSale: (
    saleId: string,
    txid: string,
    amount?: number,
    proofImageDataUrl?: string,
  ) => { ok: true; charge: PixCharge } | { ok: false; error: string }
  removePix: (id: string) => void
  amortize: (saleId: string, pixPaymentId: string, amount: number, note?: string) => { ok: boolean; error?: string }
  autoMatchSuggestions: () => Array<{ saleId: string; pixPaymentId: string; amount: number; reason: string }>
  addMemberSettlement: (input: {
    memberId: string
    raffleId?: string
    amount: number
    kind: 'dinheiro' | 'pix_vendedor'
    note?: string
    saleIds?: string[]
  }) => void
  settleCashSales: (input: {
    memberId: string
    saleIds: string[]
    memberName?: string
  }) => { ok: true; amount: number } | { ok: false; error: string }
  removeMemberSettlement: (id: string) => void
  pushAudit: (entry: AuditEntry) => void
  exportSnapshot: () => AppState
  importSnapshot: (data: AppState) => { ok: boolean; error?: string }
  seedDemo: () => void
  resetAll: () => void
}

const empty: AppState = {
  raffles: [],
  members: [],
  blocks: [],
  numberRanges: [],
  sales: [],
  pixPayments: [],
  amortizations: [],
  pixCharges: [],
  memberSettlements: [],
  blockTransfers: [],
  auditLog: [],
}

const PERSIST_KEY = 'rifa-pix-v3-blocks'

/** Cache local inchado com comprovantes base64 — limpa para o Safari voltar a gravar. */
function purgeOversizedLocalCache() {
  try {
    const raw = localStorage.getItem(PERSIST_KEY)
    if (!raw || raw.length < 1_500_000) return
    localStorage.removeItem(PERSIST_KEY)
    console.warn('Cache local do RifaPIX limpo (estava grande demais para o Safari).')
  } catch {
    try {
      localStorage.removeItem(PERSIST_KEY)
    } catch {
      /* ignore */
    }
  }
}

purgeOversizedLocalCache()

function pushTransfer(
  list: BlockTransfer[],
  input: Omit<BlockTransfer, 'id' | 'createdAt'> & { createdAt?: string },
): BlockTransfer[] {
  return [
    {
      id: uid(),
      createdAt: input.createdAt || new Date().toISOString(),
      blockId: input.blockId,
      raffleId: input.raffleId,
      fromMemberId: input.fromMemberId,
      toMemberId: input.toMemberId,
      kind: input.kind,
      note: input.note,
    },
    ...list,
  ]
}

export const useStore = create<Store>()(
  persist(
    (set, get) => ({
      ...empty,

      addRaffle: (input) => {
        const blockCount = Math.floor(input.blockCount)
        const numbersPerBlock = Math.floor(input.numbersPerBlock)
        if (!(blockCount > 0) || !(numbersPerBlock > 0)) {
          return { ok: false, error: 'Informe quantidade de blocos e cartelas por bloco.' }
        }
        if (!(input.ticketPrice > 0)) return { ok: false, error: 'Preço inválido.' }
        const totalNumbers = blockCount * numbersPerBlock
        const raffleId = uid()
        const raffle: Raffle = {
          id: raffleId,
          name: input.name.trim(),
          eventName: input.eventName.trim() || input.name.trim(),
          ticketPrice: input.ticketPrice,
          totalNumbers,
          prize: input.prize.trim(),
          active: input.active ?? true,
          blockCount,
          numbersPerBlock,
          startDate: input.startDate || undefined,
          drawDate: input.drawDate || undefined,
          createdAt: new Date().toISOString(),
        }
        const blocks: Block[] = []
        for (let i = 0; i < blockCount; i += 1) {
          const fromNumber = i * numbersPerBlock + 1
          const toNumber = (i + 1) * numbersPerBlock
          blocks.push({
            id: uid(),
            raffleId,
            index: i + 1,
            label: `Bloco ${i + 1}`,
            fromNumber,
            toNumber,
            createdAt: new Date().toISOString(),
          })
        }
        set((s) => ({
          raffles: [raffle, ...s.raffles],
          blocks: [...blocks, ...s.blocks],
        }))
        return { ok: true, raffle }
      },

      removeRaffle: (id) =>
        set((s) => ({
          raffles: s.raffles.filter((r) => r.id !== id),
          sales: s.sales.filter((sale) => sale.raffleId !== id),
          numberRanges: s.numberRanges.filter((r) => r.raffleId !== id),
          blocks: s.blocks.filter((b) => b.raffleId !== id),
          blockTransfers: s.blockTransfers.filter((t) => t.raffleId !== id),
          pixCharges: s.pixCharges.filter((c) => !s.sales.some((sale) => sale.id === c.saleId && sale.raffleId === id)),
        })),

      addMember: (input) => {
        const name = input.name.trim()
        const pin = input.pin.trim()
        if (!name) return { ok: false, error: 'Informe o nome do membro.' }
        if (pin.length < 4) return { ok: false, error: 'PIN com pelo menos 4 dígitos.' }
        if (get().members.some((m) => m.name.toLowerCase() === name.toLowerCase())) {
          return { ok: false, error: 'Já existe membro com esse nome.' }
        }
        const member: Member = {
          id: uid(),
          name,
          phone: input.phone?.trim() || undefined,
          pin,
          active: true,
          createdAt: new Date().toISOString(),
        }
        set((s) => ({ members: [member, ...s.members] }))
        return { ok: true, member }
      },

      updateMember: (id, patch) =>
        set((s) => ({
          members: s.members.map((m) => (m.id === id ? { ...m, ...patch } : m)),
        })),

      removeMember: (id) =>
        set((s) => ({
          members: s.members.filter((m) => m.id !== id),
          numberRanges: s.numberRanges.filter((r) => r.memberId !== id),
          blocks: s.blocks.map((b) => (b.memberId === id ? { ...b, memberId: undefined } : b)),
          memberSettlements: s.memberSettlements.filter((x) => x.memberId !== id),
        })),

      assignBlock: (blockId, memberId) => {
        const block = get().blocks.find((b) => b.id === blockId)
        if (!block) return { ok: false, error: 'Bloco não encontrado.' }
        if (block.memberId) {
          return { ok: false, error: 'Bloco já atribuído. Use a aba Transferências para mover entre membros.' }
        }
        if (!get().members.some((m) => m.id === memberId && m.active)) return { ok: false, error: 'Membro inválido.' }
        const st = get().blockStats(blockId)
        if (st.open <= 0) {
          return { ok: false, error: 'Esse bloco não pode ser atribuído: está vendido (sem números abertos).' }
        }
        set((s) => ({
          blocks: s.blocks.map((b) => (b.id === blockId ? { ...b, memberId } : b)),
          blockTransfers: pushTransfer(s.blockTransfers, {
            blockId,
            raffleId: block.raffleId,
            toMemberId: memberId,
            kind: 'assign',
            note: 'Atribuição inicial (Equipe)',
          }),
        }))
        return { ok: true }
      },

      transferBlock: (blockId, toMemberId) => {
        const block = get().blocks.find((b) => b.id === blockId)
        if (!block) return { ok: false, error: 'Bloco não encontrado.' }
        if (!block.memberId) {
          return { ok: false, error: 'Bloco livre. Atribua primeiro na aba Equipe.' }
        }
        if (block.memberId === toMemberId) return { ok: false, error: 'Bloco já está com este membro.' }
        if (!get().members.some((m) => m.id === toMemberId && m.active)) return { ok: false, error: 'Membro inválido.' }
        const st = get().blockStats(blockId)
        if (st.open <= 0) {
          return { ok: false, error: 'Esse bloco não pode ser transferido: está vendido (sem números abertos).' }
        }
        const fromMemberId = block.memberId
        set((s) => ({
          blocks: s.blocks.map((b) => (b.id === blockId ? { ...b, memberId: toMemberId } : b)),
          blockTransfers: pushTransfer(s.blockTransfers, {
            blockId,
            raffleId: block.raffleId,
            fromMemberId,
            toMemberId,
            kind: 'transfer',
            note: 'Transferência entre membros',
          }),
        }))
        return { ok: true }
      },

      unassignBlock: (blockId) => {
        const block = get().blocks.find((b) => b.id === blockId)
        if (!block?.memberId) {
          set((s) => ({
            blocks: s.blocks.map((b) => (b.id === blockId ? { ...b, memberId: undefined } : b)),
          }))
          return
        }
        const fromMemberId = block.memberId
        set((s) => ({
          blocks: s.blocks.map((b) => (b.id === blockId ? { ...b, memberId: undefined } : b)),
          blockTransfers: pushTransfer(s.blockTransfers, {
            blockId,
            raffleId: block.raffleId,
            fromMemberId,
            kind: 'unassign',
            note: 'Bloco liberado',
          }),
        }))
      },

      assignRange: (input) => {
        const raffle = get().raffles.find((r) => r.id === input.raffleId)
        if (!raffle) return { ok: false, error: 'Rifa/evento não encontrado.' }
        if (!get().members.some((m) => m.id === input.memberId)) return { ok: false, error: 'Membro não encontrado.' }
        const from = Math.min(input.fromNumber, input.toNumber)
        const to = Math.max(input.fromNumber, input.toNumber)
        if (from < 1 || to > raffle.totalNumbers) {
          return { ok: false, error: `Faixa deve estar entre 1 e ${raffle.totalNumbers}.` }
        }
        const clash = get().numberRanges.find(
          (r) => r.raffleId === input.raffleId && overlaps(from, to, r.fromNumber, r.toNumber),
        )
        if (clash) {
          const owner = get().members.find((m) => m.id === clash.memberId)?.name || 'outro membro'
          return { ok: false, error: `Faixa cruza com ${owner} (${clash.fromNumber}-${clash.toNumber}).` }
        }
        const range: NumberRange = {
          id: uid(),
          memberId: input.memberId,
          raffleId: input.raffleId,
          fromNumber: from,
          toNumber: to,
          createdAt: new Date().toISOString(),
        }
        set((s) => ({ numberRanges: [range, ...s.numberRanges] }))
        return { ok: true }
      },

      removeRange: (id) => set((s) => ({ numberRanges: s.numberRanges.filter((r) => r.id !== id) })),

      blockNumbers: (blockId) => {
        const block = get().blocks.find((b) => b.id === blockId)
        if (!block) return []
        const nums: number[] = []
        for (let n = block.fromNumber; n <= block.toNumber; n += 1) nums.push(n)
        return nums
      },

      memberNumbers: (memberId, raffleId, blockId) => {
        if (blockId) {
          const block = get().blocks.find((b) => b.id === blockId && b.memberId === memberId && b.raffleId === raffleId)
          return block ? get().blockNumbers(block.id) : []
        }
        const fromBlocks = get()
          .blocks.filter((b) => b.memberId === memberId && b.raffleId === raffleId)
          .flatMap((b) => get().blockNumbers(b.id))
        const ranges = get().numberRanges.filter((r) => r.memberId === memberId && r.raffleId === raffleId)
        const fromRanges: number[] = []
        for (const r of ranges) {
          for (let n = r.fromNumber; n <= r.toNumber; n += 1) fromRanges.push(n)
        }
        return [...new Set([...fromBlocks, ...fromRanges])].sort((a, b) => a - b)
      },

      soldNumbers: (raffleId) => {
        const set = new Set<number>()
        // Venda cancelada não ocupa número: volta para o bloco do membro
        for (const sale of get().sales.filter((s) => s.raffleId === raffleId && !s.cancelledAt)) {
          sale.numbers.forEach((n) => set.add(n))
        }
        return set
      },

      blockStats: (blockId) => {
        const block = get().blocks.find((b) => b.id === blockId)
        if (!block) return { total: 0, sold: 0, open: 0 }
        const nums = get().blockNumbers(blockId)
        const sold = get().soldNumbers(block.raffleId)
        const soldCount = nums.filter((n) => sold.has(n)).length
        return { total: nums.length, sold: soldCount, open: nums.length - soldCount }
      },

      memberBlockStats: (memberId, raffleId) => {
        const list = get().blocks.filter((b) => b.memberId === memberId && (!raffleId || b.raffleId === raffleId))
        let openBlocks = 0
        let soldOutBlocks = 0
        let openNumbers = 0
        let soldCount = 0
        for (const b of list) {
          const st = get().blockStats(b.id)
          openNumbers += st.open
          soldCount += st.sold
          if (st.open === 0) soldOutBlocks += 1
          else openBlocks += 1
        }
        return {
          blocks: list.length,
          openBlocks,
          soldOutBlocks,
          openNumbers,
          soldNumbers: soldCount,
        }
      },

      addSale: (input) => {
        if (input.paymentMethod === 'pix') {
          input.pixDestination = input.pixDestination || 'entidade'
        }
        if (input.paymentMethod === 'dinheiro') {
          input.cashDestination = input.cashDestination || 'vendedor'
        }

        const raffle = get().raffles.find((r) => r.id === input.raffleId)
        if (!raffle) return { ok: false, error: 'Selecione a rifa/evento.' }
        if (!get().members.some((m) => m.id === input.memberId && m.active)) {
          return { ok: false, error: 'Membro inválido.' }
        }
        if (!input.buyerName.trim()) return { ok: false, error: 'Informe o comprador.' }
        if (!input.numbers.length) return { ok: false, error: 'Selecione ao menos um número.' }
        if (input.paymentMethod === 'pix' && input.pixDestination === 'vendedor') {
          return { ok: false, error: 'PIX do membro deve ser na conta da loja.' }
        }

        const allowed = new Set(get().memberNumbers(input.memberId, input.raffleId, input.blockId))
        for (const n of input.numbers) {
          if (!allowed.has(n)) return { ok: false, error: `Número ${n} não pertence a este membro/bloco.` }
        }
        const sold = get().soldNumbers(input.raffleId)
        for (const n of input.numbers) {
          if (sold.has(n)) return { ok: false, error: `Número ${n} já vendido.` }
        }

        const totalAmount = input.numbers.length * raffle.ticketPrice
        const receivedNow = input.receivedNow ?? input.paymentMethod === 'dinheiro'
        const paidAmount = receivedNow ? totalAmount : 0
        const sale: Sale = {
          id: uid(),
          raffleId: input.raffleId,
          memberId: input.memberId,
          buyerName: input.buyerName.trim(),
          buyerPhone: input.buyerPhone?.trim() || undefined,
          numbers: [...input.numbers].sort((a, b) => a - b),
          totalAmount,
          paidAmount,
          status: saleStatus(totalAmount, paidAmount),
          paymentMethod: input.paymentMethod,
          pixDestination: input.paymentMethod === 'pix' ? input.pixDestination : undefined,
          cashDestination: input.paymentMethod === 'dinheiro' ? input.cashDestination : undefined,
          notes: input.notes?.trim() || undefined,
          soldOffline: input.soldOffline || undefined,
          createdAt: new Date().toISOString(),
          blockId: input.blockId,
          proofPath: input.proofPath || undefined,
          // só mantém data URL se ainda não houver path (modo local / fallback)
          proofImageDataUrl: input.proofPath ? undefined : input.proofImageDataUrl || undefined,
        }

        const proofTxid = input.proofTxid?.trim()
        const charge: PixCharge | null =
          proofTxid && input.paymentMethod === 'pix'
            ? {
                id: uid(),
                saleId: sale.id,
                txid: proofTxid,
                amount: totalAmount,
                status: 'pending',
                createdAt: new Date().toISOString(),
                note: 'TXID/E2E do comprovante — aguardando CSV',
                proofImageDataUrl: input.proofPath ? undefined : input.proofImageDataUrl || undefined,
              }
            : null

        set((s) => ({
          sales: [sale, ...s.sales],
          pixCharges: charge ? [charge, ...s.pixCharges] : s.pixCharges,
        }))
        rememberPendingSale(sale)
        return { ok: true, sale }
      },

      patchSale: (id, patch) =>
        set((s) => ({
          sales: s.sales.map((sale) => (sale.id === id ? { ...sale, ...patch } : sale)),
        })),

      removeSale: (id) =>
        set((s) => {
          savePendingSales(loadPendingSales().filter((p) => p.id !== id))
          const linked = s.amortizations.filter((a) => a.saleId === id)
          const pixAdjust = new Map<string, number>()
          for (const a of linked) {
            pixAdjust.set(a.pixPaymentId, (pixAdjust.get(a.pixPaymentId) ?? 0) + a.amount)
          }
          return {
            sales: s.sales.filter((sale) => sale.id !== id),
            amortizations: s.amortizations.filter((a) => a.saleId !== id),
            pixCharges: s.pixCharges.filter((c) => c.saleId !== id),
            pixPayments: s.pixPayments.map((p) => {
              const subtract = pixAdjust.get(p.id)
              if (!subtract) return p
              const allocatedAmount = Math.max(0, p.allocatedAmount - subtract)
              return {
                ...p,
                allocatedAmount,
                matchedSaleId: allocatedAmount > 0 ? p.matchedSaleId : undefined,
              }
            }),
          }
        }),

      addPix: (input) => {
        const pix: PixPayment = {
          id: uid(),
          amount: input.amount,
          paidAt: input.paidAt,
          payerName: input.payerName.trim(),
          txid: input.txid?.trim() || undefined,
          endToEndId: input.endToEndId?.trim() || undefined,
          notes: input.notes?.trim() || undefined,
          allocatedAmount: 0,
          createdAt: new Date().toISOString(),
        }
        set((s) => ({ pixPayments: [pix, ...s.pixPayments] }))
      },

      addPixBulk: (inputs) => {
        const existing = get().pixPayments
        const seen = new Set(
          existing.map((p) => `${p.paidAt}|${p.amount}|${p.payerName.trim().toLowerCase()}|${p.txid || ''}|${p.endToEndId || ''}`),
        )
        const created: PixPayment[] = []
        let skipped = 0
        for (const input of inputs) {
          const payerName = input.payerName.trim()
          const key = `${input.paidAt}|${input.amount}|${payerName.toLowerCase()}|${input.txid?.trim() || ''}|${input.endToEndId?.trim() || ''}`
          if (seen.has(key)) {
            skipped += 1
            continue
          }
          seen.add(key)
          created.push({
            id: uid(),
            amount: input.amount,
            paidAt: input.paidAt,
            payerName,
            txid: input.txid?.trim() || undefined,
            endToEndId: input.endToEndId?.trim() || undefined,
            notes: input.notes?.trim() || undefined,
            allocatedAmount: 0,
            createdAt: new Date().toISOString(),
          })
        }
        if (created.length) set((s) => ({ pixPayments: [...created, ...s.pixPayments] }))
        return { imported: created.length, skipped }
      },

      importCsvAndSettleByTxid: (rows) => {
        const bulk = get().addPixBulk(rows)
        const matches = previewTxidMatches(
          rows,
          get().pixCharges.map((c) => ({
            id: c.id,
            saleId: c.saleId,
            txid: c.txid,
            amount: c.amount,
            status: c.status,
          })),
        )
        let settled = 0
        for (const match of matches) {
          const pix = get().pixPayments.find((p) => {
            const t = (p.txid || '').trim().toLowerCase()
            const e = (p.endToEndId || '').trim().toLowerCase()
            const key = match.txid.trim().toLowerCase()
            return (
              p.allocatedAmount < p.amount - 0.009 &&
              (t === key || e === key) &&
              Math.abs(p.amount - match.row.amount) < 0.01 &&
              p.paidAt === match.row.paidAt
            )
          })
          if (!pix) continue
          const result = get().amortize(match.saleId, pix.id, match.settleAmount, `Baixa automática por ${match.confidence}`)
          if (!result.ok) continue
          settled += 1
          set((s) => ({
            pixCharges: s.pixCharges.map((c) =>
              c.id === match.chargeId ? { ...c, status: 'paid' as const, paidAt: new Date().toISOString() } : c,
            ),
          }))
        }
        const rowsWithId = rows.filter((r) => r.txid || r.endToEndId).length
        return {
          imported: bulk.imported,
          skipped: bulk.skipped,
          settled,
          unmatchedWithTxid: Math.max(0, rowsWithId - settled),
        }
      },

      createChargeForSale: (saleId, amount) => {
        const sale = get().sales.find((s) => s.id === saleId)
        if (!sale) return { ok: false, error: 'Venda não encontrada.' }
        const open = sale.totalAmount - sale.paidAmount
        if (open <= 0.009) return { ok: false, error: 'Venda já quitada.' }
        const value = amount ?? open
        const txid = makeLocalTxid()
        const copyPaste = buildMockPixCopiaECola(value, txid)
        const charge: PixCharge = {
          id: uid(),
          saleId,
          txid,
          amount: value,
          status: 'pending',
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
          copyPaste,
          qrCode: copyPaste,
          provider: 'mock',
        }
        set((s) => ({ pixCharges: [charge, ...s.pixCharges] }))
        return { ok: true, charge }
      },

      registerPixCharge: (input) => {
        const sale = get().sales.find((s) => s.id === input.saleId)
        if (!sale) return { ok: false, error: 'Venda não encontrada.' }
        const charge: PixCharge = {
          id: input.id || uid(),
          saleId: input.saleId,
          txid: input.txid,
          amount: input.amount,
          status: 'pending',
          createdAt: new Date().toISOString(),
          copyPaste: input.copyPaste,
          qrCode: input.qrCode || input.copyPaste,
          provider: input.provider,
          expiresAt: input.expiresAt,
        }
        set((s) => ({ pixCharges: [charge, ...s.pixCharges.filter((c) => c.saleId !== input.saleId || c.status !== 'pending')] }))
        return { ok: true, charge }
      },

      settlePixChargeByTxid: (txid, amount, saleId) => {
        const clean = txid.trim()
        const charge = get().pixCharges.find((c) => c.txid.toLowerCase() === clean.toLowerCase())
        const sid = saleId || charge?.saleId
        if (!sid) return { ok: false, error: 'Cobrança/venda não encontrada para este TXID.' }
        const sale = get().sales.find((s) => s.id === sid)
        if (!sale) return { ok: false, error: 'Venda não encontrada.' }
        const add = amount ?? charge?.amount ?? Math.max(0, sale.totalAmount - sale.paidAmount)
        const paidAmount = Math.min(sale.totalAmount, Math.max(sale.paidAmount, add))
        const status = saleStatus(sale.totalAmount, paidAmount)
        const paidAt = new Date().toISOString()
        // Pagamento que cai depois do cancelamento reativa a venda: o dinheiro entrou de fato
        const reactivated = Boolean(sale.cancelledAt)
        set((s) => ({
          sales: s.sales.map((x) =>
            x.id === sid
              ? {
                  ...x,
                  paidAmount,
                  status,
                  cancelledAt: undefined,
                  cancelReason: undefined,
                  cancelNote: undefined,
                  cancelledBy: undefined,
                }
              : x,
          ),
          pixCharges: s.pixCharges.map((c) =>
            c.txid.toLowerCase() === clean.toLowerCase() ||
            (c.saleId === sid && (c.status === 'pending' || c.status === 'expired' || c.status === 'cancelled'))
              ? { ...c, status: 'paid' as const, paidAt }
              : c,
          ),
        }))
        return { ok: true, saleId: sid, reactivated }
      },

      expireStalePixCharges: () => {
        const now = Date.now()
        const expiredSaleIds: string[] = []
        set((s) => {
          const hitSaleIds = new Set<string>()
          const vencida = (c: PixCharge) => {
            const expMs = pixChargeExpiryMs(c)
            return expMs != null && expMs < now
          }
          /** Ainda dá para pagar? Então a venda não pode ser cancelada. */
          const temCobrancaViva = (saleId: string) =>
            s.pixCharges.some(
              (c) => c.saleId === saleId && (c.status === 'paid' || (c.status === 'pending' && !vencida(c))),
            )

          const pixCharges = s.pixCharges.map((c) => {
            const sale = c.saleId ? s.sales.find((x) => x.id === c.saleId) : undefined
            const vendaAberta = Boolean(sale && !sale.cancelledAt && sale.status !== 'quitado')

            if (c.status === 'pending') {
              if (!vencida(c)) return c
              // Pago não expira, mesmo que o QR tenha vencido depois
              if (!vendaAberta) return { ...c, status: 'expired' as const }
              if (c.saleId && !temCobrancaViva(c.saleId)) hitSaleIds.add(c.saleId)
              return { ...c, status: 'expired' as const }
            }

            // Cobrança já vencida/cancelada na nuvem, mas a venda ficou aberta:
            // sem isso o número ficaria preso e a venda em "aguardando pagamento".
            if ((c.status === 'expired' || c.status === 'cancelled') && vendaAberta && c.saleId) {
              if (!temCobrancaViva(c.saleId)) hitSaleIds.add(c.saleId)
            }
            return c
          })
          if (!hitSaleIds.size) return { pixCharges }
          const at = new Date().toISOString()
          const sales = s.sales.map((sale) => {
            if (!hitSaleIds.has(sale.id) || sale.cancelledAt || sale.status === 'quitado') return sale
            expiredSaleIds.push(sale.id)
            return { ...sale, cancelledAt: at, cancelReason: 'expirado' as const, paidAmount: 0 }
          })
          if (!expiredSaleIds.length) return { pixCharges }
          return { pixCharges, sales }
        })
        return expiredSaleIds
      },

      cancelPixSale: (saleId, reason, info) => {
        const sale = get().sales.find((s) => s.id === saleId)
        if (!sale) return { ok: false, error: 'Venda não encontrada.' }
        if (sale.cancelledAt) return { ok: false, error: 'Esta venda já está cancelada.' }
        if (sale.status === 'quitado') return { ok: false, error: 'Venda já paga — não pode ser cancelada.' }
        const at = new Date().toISOString()
        set((s) => ({
          sales: s.sales.map((x) =>
            x.id === saleId
              ? {
                  ...x,
                  cancelledAt: at,
                  cancelReason: reason,
                  cancelNote: info?.note?.trim() || undefined,
                  cancelledBy: info?.by?.trim() || undefined,
                  paidAmount: 0,
                }
              : x,
          ),
          pixCharges: s.pixCharges.map((c) =>
            c.saleId === saleId && c.status === 'pending'
              ? { ...c, status: reason === 'expirado' ? ('expired' as const) : ('cancelled' as const) }
              : c,
          ),
        }))
        return { ok: true, numbers: [...sale.numbers] }
      },

      attachTxidToSale: (saleId, txid, amount, proofImageDataUrl) => {
        const clean = txid.trim()
        if (!clean) return { ok: false, error: 'Informe o TXID.' }
        const sale = get().sales.find((s) => s.id === saleId)
        if (!sale) return { ok: false, error: 'Venda não encontrada.' }
        const open = Math.max(sale.totalAmount - sale.paidAmount, sale.totalAmount)
        const value = amount ?? open
        if (get().pixCharges.some((c) => c.txid.toLowerCase() === clean.toLowerCase())) {
          return { ok: false, error: 'TXID já cadastrado.' }
        }
        const charge: PixCharge = {
          id: uid(),
          saleId,
          txid: clean,
          amount: value,
          status: 'pending',
          createdAt: new Date().toISOString(),
          note: 'TXID/E2E do comprovante',
          proofImageDataUrl,
        }
        set((s) => ({ pixCharges: [charge, ...s.pixCharges] }))
        return { ok: true, charge }
      },

      removePix: (id) =>
        set((s) => {
          const linked = s.amortizations.filter((a) => a.pixPaymentId === id)
          const saleAdjust = new Map<string, number>()
          for (const a of linked) saleAdjust.set(a.saleId, (saleAdjust.get(a.saleId) ?? 0) + a.amount)
          return {
            pixPayments: s.pixPayments.filter((p) => p.id !== id),
            amortizations: s.amortizations.filter((a) => a.pixPaymentId !== id),
            sales: s.sales.map((sale) => {
              const subtract = saleAdjust.get(sale.id)
              if (!subtract) return sale
              const paidAmount = Math.max(0, sale.paidAmount - subtract)
              return { ...sale, paidAmount, status: saleStatus(sale.totalAmount, paidAmount) }
            }),
          }
        }),

      amortize: (saleId, pixPaymentId, amount, note) => {
        const sale = get().sales.find((s) => s.id === saleId)
        const pix = get().pixPayments.find((p) => p.id === pixPaymentId)
        if (!sale || !pix) return { ok: false, error: 'Venda ou PIX não encontrado.' }
        if (amount <= 0) return { ok: false, error: 'Valor deve ser maior que zero.' }
        const saleOpen = Math.max(0, sale.totalAmount - sale.paidAmount)
        const pixOpen = Math.max(0, pix.amount - pix.allocatedAmount)
        if (amount - saleOpen > 0.009) return { ok: false, error: `Venda só tem R$ ${saleOpen.toFixed(2)} em aberto.` }
        if (amount - pixOpen > 0.009) return { ok: false, error: `PIX só tem R$ ${pixOpen.toFixed(2)} disponível.` }
        const entry: AmortizationEntry = {
          id: uid(),
          saleId,
          pixPaymentId,
          amount,
          createdAt: new Date().toISOString(),
          note: note?.trim() || undefined,
        }
        set((s) => ({
          amortizations: [entry, ...s.amortizations],
          sales: s.sales.map((item) => {
            if (item.id !== saleId) return item
            const paidAmount = item.paidAmount + amount
            return { ...item, paidAmount, status: saleStatus(item.totalAmount, paidAmount) }
          }),
          pixPayments: s.pixPayments.map((item) => {
            if (item.id !== pixPaymentId) return item
            return {
              ...item,
              allocatedAmount: item.allocatedAmount + amount,
              matchedSaleId: item.matchedSaleId ?? saleId,
            }
          }),
        }))
        return { ok: true }
      },

      autoMatchSuggestions: () => {
        const { sales, pixPayments, pixCharges } = get()
        const openSales = sales.filter((s) => s.paidAmount < s.totalAmount - 0.009)
        const openPix = pixPayments.filter((p) => p.allocatedAmount < p.amount - 0.009)
        const suggestions: Array<{ saleId: string; pixPaymentId: string; amount: number; reason: string }> = []
        const usedPix = new Set<string>()
        const usedSales = new Set<string>()

        for (const charge of pixCharges.filter((c) => c.status === 'pending')) {
          if (usedSales.has(charge.saleId)) continue
          const sale = openSales.find((s) => s.id === charge.saleId)
          if (!sale) continue
          const key = charge.txid.trim().toLowerCase()
          const pix = openPix.find((p) => {
            if (usedPix.has(p.id)) return false
            const t = (p.txid || '').trim().toLowerCase()
            const e = (p.endToEndId || '').trim().toLowerCase()
            return t === key || e === key
          })
          if (!pix) continue
          suggestions.push({
            saleId: sale.id,
            pixPaymentId: pix.id,
            amount: Math.min(sale.totalAmount - sale.paidAmount, pix.amount - pix.allocatedAmount, charge.amount),
            reason: 'TXID / End-to-end idêntico',
          })
          usedPix.add(pix.id)
          usedSales.add(sale.id)
        }
        return suggestions
      },

      addMemberSettlement: (input) => {
        if (!(input.amount > 0)) return
        const row: MemberSettlement = {
          id: uid(),
          memberId: input.memberId,
          raffleId: input.raffleId,
          amount: input.amount,
          kind: input.kind,
          note: input.note?.trim() || undefined,
          createdAt: new Date().toISOString(),
          saleIds: input.saleIds,
        }
        set((s) => ({ memberSettlements: [row, ...s.memberSettlements] }))
      },

      settleCashSales: (input) => {
        const ids = new Set(input.saleIds)
        if (!ids.size) return { ok: false, error: 'Selecione ao menos uma venda.' }
        const pending = get().sales.filter(
          (sale) =>
            ids.has(sale.id) &&
            sale.memberId === input.memberId &&
            sale.paymentMethod === 'dinheiro' &&
            (sale.cashDestination || 'vendedor') === 'vendedor' &&
            !sale.cashSettledAt,
        )
        if (!pending.length) return { ok: false, error: 'Nenhuma pendência válida selecionada.' }
        const amount = Math.round(pending.reduce((a, s) => a + s.totalAmount, 0) * 100) / 100
        const now = new Date().toISOString()
        const note = `Baixado e assinado por todos · ADM + ${input.memberName || 'membro'}`
        const saleIds = pending.map((s) => s.id)
        const row: MemberSettlement = {
          id: uid(),
          memberId: input.memberId,
          amount,
          kind: 'dinheiro',
          note,
          createdAt: now,
          saleIds,
        }
        set((s) => ({
          sales: s.sales.map((sale) =>
            saleIds.includes(sale.id)
              ? {
                  ...sale,
                  cashSettledAt: now,
                  cashSettlementNote: note,
                  paidAmount: sale.totalAmount,
                  status: 'quitado' as const,
                }
              : sale,
          ),
          memberSettlements: [row, ...s.memberSettlements],
        }))
        return { ok: true, amount }
      },

      removeMemberSettlement: (id) => set((s) => ({ memberSettlements: s.memberSettlements.filter((x) => x.id !== id) })),

      pushAudit: (entry) =>
        set((s) => ({
          auditLog: [entry, ...(s.auditLog || [])].slice(0, AUDIT_MAX),
        })),

      exportSnapshot: () => {
        const s = get()
        return {
          raffles: s.raffles,
          members: s.members,
          blocks: s.blocks,
          numberRanges: s.numberRanges,
          sales: s.sales,
          pixPayments: s.pixPayments,
          amortizations: s.amortizations,
          pixCharges: s.pixCharges,
          memberSettlements: s.memberSettlements,
          blockTransfers: s.blockTransfers,
          auditLog: s.auditLog || [],
        }
      },

      importSnapshot: (data) => {
        if (!data || !Array.isArray(data.raffles) || !Array.isArray(data.sales)) {
          return { ok: false, error: 'Backup inválido.' }
        }
        const members = data.members || []
        const raffles = data.raffles
        const auditLog = mergeAudit(data.auditLog, get().auditLog)
        const base = mergeSales(data.sales, mergeSales(get().sales, loadPendingSales()))
        const sales = mergeSales(base, salesFromAudit(auditLog, base, members, raffles))
        set({
          raffles,
          members,
          blocks: data.blocks || [],
          numberRanges: data.numberRanges || [],
          sales,
          pixPayments: data.pixPayments || [],
          amortizations: data.amortizations || [],
          pixCharges: mergeCharges(data.pixCharges || [], get().pixCharges),
          memberSettlements: data.memberSettlements || [],
          blockTransfers: data.blockTransfers || [],
          auditLog,
        })
        return { ok: true }
      },

      seedDemo: () => {
        const raffleId = uid()
        const m1 = uid()
        const m2 = uid()
        const now = new Date().toISOString()
        const blocks: Block[] = []
        for (let i = 0; i < 4; i += 1) {
          const fromNumber = i * 50 + 1
          const toNumber = (i + 1) * 50
          blocks.push({
            id: uid(),
            raffleId,
            index: i + 1,
            label: `Bloco ${i + 1}`,
            fromNumber,
            toNumber,
            memberId: i < 2 ? m1 : m2,
            createdAt: now,
          })
        }
        set({
          raffles: [
            {
              id: raffleId,
              name: 'Rifa Churrasco',
              eventName: 'Festa da Turma 2026',
              ticketPrice: 10,
              totalNumbers: 200,
              prize: 'Kit churrasco',
              active: true,
              blockCount: 4,
              numbersPerBlock: 50,
              createdAt: now,
            },
          ],
          members: [
            { id: m1, name: 'Carlos', pin: '1234', phone: '11999990001', active: true, createdAt: now },
            { id: m2, name: 'Fernanda', pin: '5678', phone: '11999990002', active: true, createdAt: now },
          ],
          blocks,
          numberRanges: [],
          sales: [
            {
              id: uid(),
              raffleId,
              memberId: m1,
              blockId: blocks[0].id,
              buyerName: 'Maria Souza',
              numbers: [7, 8, 9],
              totalAmount: 30,
              paidAmount: 30,
              status: 'quitado',
              paymentMethod: 'dinheiro',
              cashDestination: 'vendedor',
              createdAt: now,
            },
          ],
          pixPayments: [],
          amortizations: [],
          pixCharges: [],
          memberSettlements: [],
          blockTransfers: [
            {
              id: uid(),
              blockId: blocks[0].id,
              raffleId,
              toMemberId: m1,
              kind: 'assign',
              createdAt: now,
              note: 'Demo',
            },
            {
              id: uid(),
              blockId: blocks[1].id,
              raffleId,
              toMemberId: m1,
              kind: 'assign',
              createdAt: now,
              note: 'Demo',
            },
            {
              id: uid(),
              blockId: blocks[2].id,
              raffleId,
              toMemberId: m2,
              kind: 'assign',
              createdAt: now,
              note: 'Demo',
            },
            {
              id: uid(),
              blockId: blocks[3].id,
              raffleId,
              toMemberId: m2,
              kind: 'assign',
              createdAt: now,
              note: 'Demo',
            },
          ],
        })
      },

      // O rastro de ações nunca é apagado, nem ao limpar os dados
      resetAll: () => set((s) => ({ ...empty, auditLog: s.auditLog || [] })),
    }),
    {
      name: PERSIST_KEY,
      // Não grava base64 de comprovante no Safari (estoura ~5 MB e gera "quota exceeded")
      partialize: (state) => ({
        raffles: state.raffles,
        members: state.members,
        blocks: state.blocks,
        numberRanges: state.numberRanges,
        sales: state.sales.map((s) =>
          s.proofImageDataUrl ? { ...s, proofImageDataUrl: undefined } : s,
        ),
        pixPayments: state.pixPayments,
        amortizations: state.amortizations,
        pixCharges: state.pixCharges.map((c) =>
          c.proofImageDataUrl ? { ...c, proofImageDataUrl: undefined } : c,
        ),
        memberSettlements: state.memberSettlements,
        blockTransfers: state.blockTransfers,
        auditLog: state.auditLog || [],
      }),
      storage: createJSONStorage(() => ({
        getItem: (name) => localStorage.getItem(name),
        setItem: (name, value) => {
          try {
            localStorage.setItem(name, value)
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            if (!/quota/i.test(msg) && !(err instanceof DOMException && err.name === 'QuotaExceededError')) {
              throw err
            }
            try {
              localStorage.removeItem(name)
              localStorage.setItem(name, value)
            } catch {
              console.warn('Safari sem espaço local; estado fica só em memória nesta sessão.')
            }
          }
        },
        removeItem: (name) => localStorage.removeItem(name),
      })),
      merge: (persisted, current) => {
        const p = (persisted || {}) as Partial<AppState>
        return {
          ...current,
          ...p,
          raffles: (p.raffles || []).map((r) => ({
            ...r,
            eventName: r.eventName || r.name,
            active: r.active ?? true,
          })),
          members: p.members || [],
          blocks: p.blocks || [],
          numberRanges: p.numberRanges || [],
          sales: (p.sales || []).map((s) => ({
            ...s,
            memberId: s.memberId || '',
            paymentMethod: s.paymentMethod || 'pix',
            cashDestination:
              s.paymentMethod === 'dinheiro' ? s.cashDestination || ('vendedor' as const) : s.cashDestination,
            soldOffline: s.soldOffline || /contingenc/i.test(s.notes || '') || undefined,
          })),
          pixPayments: p.pixPayments || [],
          amortizations: p.amortizations || [],
          pixCharges: p.pixCharges || [],
          memberSettlements: p.memberSettlements || [],
          blockTransfers: p.blockTransfers || [],
        }
      },
    },
  ),
)

export function brl(value: number) {
  return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

export function formatNumbers(numbers: number[]) {
  return numbers.map((n) => String(n).padStart(2, '0')).join(', ')
}
