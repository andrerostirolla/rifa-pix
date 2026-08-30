import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { getAuthRecord, getSession, logout } from './auth'
import { NumberGrid } from './NumberGrid'
import { isSupabaseConfigured, supabase } from './lib/supabase'
import { openProofUrl, resolveProofUrl, uploadProofFile } from './lib/proofs'
import { loadCloudSession, saveCloudSession, flushWorkspaceToCloud, fetchByAccessCode, syncCloudSessionMeta, requestCloudPush } from './lib/workspace'
import {
  createWorkspacePixCharge,
  checkWorkspacePixCharge,
  listWorkspacePixCharges,
  getStoredMemberPin,
} from './lib/pixWorkspace'
import { createWorkspaceAdmin, logAudit } from './lib/audit'
import { useCloudSync } from './lib/cloudSyncContext'
import { PixChargeModal } from './PixChargeModal'
import { SettlementConfirmModal } from './SettlementConfirmModal'
import { AdminConfirmModal } from './AdminConfirmModal'
import { CancelReasonModal } from './CancelReasonModal'
import { MemberEditModal } from './MemberEditModal'
import { InfoPopover } from './InfoPopover'
import { adminCredentialHint, verifyAdminCredential } from './lib/adminGuard'
import { formatErr } from './lib/errors'
import { brl, cancelInfo, formatNumbers, isPixChargeExpired, useStore } from './store'
import { TeamChat } from './TeamChat'
import { InstallAppButton } from './InstallAppButton'
import { formatDrawDate, parseDrawDate, todaySalesQuote } from './lib/salesQuotes'
import type {
  AuditEntry,
  CashDestination,
  PaymentMethod,
  PaymentStatus,
  PixCharge,
  PixDestination,
  Sale,
} from './types'

type AdminTab =
  | 'painel'
  | 'equipe'
  | 'transferencias'
  | 'eventos'
  | 'vendas'
  | 'txid'
  | 'amortizacao'
  | 'relatorios'
  | 'auditoria'
type MemberTab = 'blocos' | 'vendas' | 'lista-vendas' | 'lista-pix'

type SensitiveOp =
  | { type: 'liberar'; blockId: string; memberId: string }
  | { type: 'removerMembro'; memberId: string }
  | { type: 'removerEvento'; raffleId: string }
  | { type: 'transferir'; toMemberId: string; blockIds: string[] }
  | { type: 'atribuir'; memberId: string; blockIds: string[] }

const statusLabel: Record<PaymentStatus, string> = {
  pendente: 'Pendente',
  parcial: 'Parcial',
  quitado: 'Quitado',
  divergente: 'Divergente',
}

const auditActionLabel: Record<string, string> = {
  'membro.criar': 'Salvou membro',
  'membro.editar': 'Editou membro',
  'membro.remover': 'Removeu membro',
  'membro.acesso_total': 'Deu acesso total (ADM)',
  'bloco.atribuir': 'Atribuiu bloco',
  'bloco.transferir': 'Transferiu bloco',
  'bloco.liberar': 'Liberou bloco',
  'evento.criar': 'Criou evento com blocos',
  'evento.remover': 'Removeu evento',
  'venda.registrar': 'Registrou venda',
  'venda.dinheiro': 'Venda em dinheiro',
  'venda.pix': 'Venda PIX recebida',
  'venda.pix_gerada': 'Gerou QR do PIX',
  'venda.contingencia': 'Venda em contingência',
  'venda.pix_cancelada': 'Cancelou PIX (membro)',
  'venda.pix_expirada': 'PIX cancelado por tempo',
  'venda.pix_pago_apos_cancelar': 'PIX pago após cancelamento',
  'dinheiro.liquidar': 'Baixou prestação em dinheiro',
  'dados.limpar': 'Limpou os dados',
  'dados.demo': 'Carregou demo',
}

function downloadCsv(filename: string, rows: string[][]) {
  const escape = (v: string) => `"${String(v).replace(/"/g, '""')}"`
  const csv = rows.map((r) => r.map(escape).join(';')).join('\r\n')
  const blob = new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/** Percentual curto para os cartões do resumo. */
function pct(part: number, total: number) {
  if (!total) return '—'
  return `${Math.round((part / total) * 100)}%`
}

/** Quantidade de números numa ação de auditoria (meta Números ou Quantidade). */
function auditNumberQty(entry: AuditEntry): number {
  const raw = entry.meta?.Números || ''
  const nums = raw
    .split(/[^\d]+/)
    .map((x) => Number(x))
    .filter((n) => Number.isFinite(n) && n > 0)
  if (nums.length) return nums.length
  const q = Number(String(entry.meta?.Quantidade || '').replace(/[^\d]/g, ''))
  return Number.isFinite(q) && q > 0 ? q : 0
}

/** Linhas do popover de auditoria: usa os campos gravados e cai no texto simples se não houver. */
function auditPopoverLines(entry: AuditEntry, situacao?: string | null) {
  const meta: Record<string, string> = { ...(entry.meta || {}) }
  // A situação gravada envelhece (ex.: "Aguardando pagamento" de um PIX que já foi pago):
  // quando dá para saber o estado atual da venda, ele manda.
  if (situacao) meta['Situação'] = situacao
  const metaLines = Object.entries(meta).map(([k, v]) => `${k}: ${v}`)
  if (metaLines.length) return metaLines
  return [entry.detail || 'Sem detalhes gravados nesta ação.']
}

/** Situação de agora da venda ligada à ação — o PIX pode ter sido pago, cancelado ou vencido depois. */
function liveAuditSituacao(entry: AuditEntry, sales: Sale[], pixCharges: PixCharge[]): string | null {
  if (!entry.action.startsWith('venda.')) return null

  const txid = entry.ref?.txid || entry.meta?.TXID
  let charge = txid ? pixCharges.find((c) => c.txid === txid) : undefined
  const saleId = entry.ref?.saleId || charge?.saleId
  const sale = saleId ? sales.find((s) => s.id === saleId) : undefined
  if (!sale) return null
  if (!charge) {
    const ofSale = pixCharges.filter((c) => c.saleId === sale.id)
    charge = ofSale[ofSale.length - 1]
  }

  if (sale.cancelledAt) {
    return cancelInfo(sale, charge)?.byMember ? 'Cancelado pelo membro' : 'PIX cancelado por tempo (expirou)'
  }
  if (sale.paymentMethod === 'pix') {
    if (sale.status === 'quitado') return 'PIX efetivado'
    if (isPixChargeExpired(charge)) return 'PIX cancelado por tempo (expirou)'
    return 'Aguardando pagamento'
  }
  // Dinheiro entra quitado: o comprador já pagou, só falta prestar contas
  if (sale.cashSettledAt) return 'Quitado — dinheiro prestado (conta da loja)'
  if ((sale.cashDestination || 'vendedor') === 'loja') return 'Quitado — dinheiro entregue na loja'
  return 'Quitado — dinheiro com o vendedor'
}

function askProceed(message = 'Tem certeza que deseja prosseguir com essa operação?') {
  return window.confirm(message)
}

function isCashPending(s: {
  paymentMethod: string
  cashDestination?: string
  cashSettledAt?: string
  cancelledAt?: string
}) {
  return (
    s.paymentMethod === 'dinheiro' &&
    (s.cashDestination || 'vendedor') === 'vendedor' &&
    !s.cashSettledAt &&
    !s.cancelledAt
  )
}

function isPixToReview(
  s: { id: string; paymentMethod: string; status: PaymentStatus; cancelledAt?: string; cancelReason?: string },
  charges: PixCharge[],
) {
  if (s.paymentMethod !== 'pix') return false
  const charge = charges.find((c) => c.saleId === s.id)
  const waiting = !s.cancelledAt && s.status === 'pendente' && !isPixChargeExpired(charge)
  const expired =
    s.cancelReason === 'expirado' ||
    (!s.cancelledAt && s.status === 'pendente' && isPixChargeExpired(charge))
  return waiting || expired
}

function saleUiStatus(
  s: {
    id: string
    status: PaymentStatus
    paymentMethod: string
    cashDestination?: string
    cashSettledAt?: string
    cancelledAt?: string
  },
  charges: Array<{ saleId: string; status: string }>,
): 'quitado' | 'pendente' | 'falha' {
  const charge = charges.find((c) => c.saleId === s.id)
  if (s.cancelledAt) return 'falha'
  if (s.status === 'divergente' || charge?.status === 'expired' || charge?.status === 'cancelled') return 'falha'
  if (s.paymentMethod === 'dinheiro') {
    if ((s.cashDestination || 'vendedor') === 'loja' || s.cashSettledAt) return 'quitado'
    return 'pendente'
  }
  if (s.status === 'quitado' || charge?.status === 'paid') return 'quitado'
  if (s.status === 'parcial') return 'falha'
  return 'pendente'
}

function ProofIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path d="M14 2v6h6" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M8 13h8M8 17h5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(new Error('Falha ao ler arquivo'))
    reader.readAsDataURL(file)
  })
}

function proofUrlForSale(
  sale: { id: string; proofPath?: string; proofImageDataUrl?: string },
  charges: Array<{ saleId: string; proofImageDataUrl?: string }>,
) {
  const fromSale = resolveProofUrl(sale)
  if (fromSale) return fromSale
  return charges.find((c) => c.saleId === sale.id)?.proofImageDataUrl || ''
}

export default function LocalApp() {
  const session = getSession()
  const isAdmin = session?.role === 'admin'
  const memberId = session?.memberId || ''
  const { cloudOk } = useCloudSync()
  /** Sem nuvem: contingência — só dinheiro local; PIX bloqueado */
  const offlineContingency = isSupabaseConfigured && !cloudOk

  const [adminTab, setAdminTab] = useState<AdminTab>('painel')
  const [memberTab, setMemberTab] = useState<MemberTab>('blocos')
  const [toast, setToast] = useState<string | null>(null)
  const [selectedNumbers, setSelectedNumbers] = useState<number[]>([])
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('dinheiro')
  const [pixDestination, setPixDestination] = useState<PixDestination>('entidade')
  const [cashDestination, setCashDestination] = useState<CashDestination>('vendedor')
  const [saleRaffleId, setSaleRaffleId] = useState('')
  const [assignBlockIds, setAssignBlockIds] = useState<string[]>([])
  const [transferBlockIds, setTransferBlockIds] = useState<string[]>([])
  const [baixaMemberId, setBaixaMemberId] = useState('')
  const [baixaSelectedIds, setBaixaSelectedIds] = useState<string[]>([])
  const [settlingBaixa, setSettlingBaixa] = useState(false)
  const [baixaConfirmOpen, setBaixaConfirmOpen] = useState(false)
  const [baixaConfirmError, setBaixaConfirmError] = useState<string | null>(null)
  const [wipeOpen, setWipeOpen] = useState(false)
  const [wipeBusy, setWipeBusy] = useState(false)
  const [wipeError, setWipeError] = useState<string | null>(null)
  const [sensitiveOp, setSensitiveOp] = useState<SensitiveOp | null>(null)
  const [sensitiveBusy, setSensitiveBusy] = useState(false)
  const [sensitiveError, setSensitiveError] = useState<string | null>(null)
  const [auditQuery, setAuditQuery] = useState('')
  const [cancelAsk, setCancelAsk] = useState<{ saleId: string; fromModal: boolean } | null>(null)
  const [cancelBusy, setCancelBusy] = useState(false)
  const [editMemberId, setEditMemberId] = useState<string | null>(null)
  const [editMemberError, setEditMemberError] = useState<string | null>(null)
  const [fullAccess, setFullAccess] = useState(false)
  const [openBlockId, setOpenBlockId] = useState<string | null>(null)
  const [openEventId, setOpenEventId] = useState<string | null>(null)
  const [filterEventId, setFilterEventId] = useState('')
  const [transferEventId, setTransferEventId] = useState('')
  const [proofDataUrl, setProofDataUrl] = useState('')
  const [pixModal, setPixModal] = useState<{
    buyerName: string
    amount: number
    copyPaste: string
    txid: string
    saleId?: string
    isDemo?: boolean
    expiresAt?: string
    reopened?: boolean
  } | null>(null)
  const [checkingPix, setCheckingPix] = useState(false)
  const [pixPaid, setPixPaid] = useState(false)
  const [savingSale, setSavingSale] = useState(false)
  const [reportMemberId, setReportMemberId] = useState('')
  const [reportEventId, setReportEventId] = useState('')
  const [reportDetail, setReportDetail] = useState<'resumo' | 'vendas' | 'blocos' | 'baixas' | 'movimentos'>('resumo')
  const pixCheckLock = useRef(false)
  const saleFormRef = useRef<HTMLFormElement | null>(null)

  const raffles = useStore((s) => s.raffles)
  const members = useStore((s) => s.members)
  const blocks = useStore((s) => s.blocks)
  const sales = useStore((s) => s.sales)
  const pixPayments = useStore((s) => s.pixPayments)
  const amortizations = useStore((s) => s.amortizations)
  const pixCharges = useStore((s) => s.pixCharges)
  const memberSettlements = useStore((s) => s.memberSettlements)
  const blockTransfers = useStore((s) => s.blockTransfers)
  const auditLog = useStore((s) => s.auditLog)
  const addRaffle = useStore((s) => s.addRaffle)
  const removeRaffle = useStore((s) => s.removeRaffle)
  const addMember = useStore((s) => s.addMember)
  const removeMember = useStore((s) => s.removeMember)
  const updateMember = useStore((s) => s.updateMember)
  const assignBlock = useStore((s) => s.assignBlock)
  const transferBlock = useStore((s) => s.transferBlock)
  const unassignBlock = useStore((s) => s.unassignBlock)
  const memberNumbers = useStore((s) => s.memberNumbers)
  const soldNumbers = useStore((s) => s.soldNumbers)
  const blockStats = useStore((s) => s.blockStats)
  const memberBlockStats = useStore((s) => s.memberBlockStats)
  const addSale = useStore((s) => s.addSale)
  const removeSale = useStore((s) => s.removeSale)
  const settlePixChargeByTxid = useStore((s) => s.settlePixChargeByTxid)
  const expireStalePixCharges = useStore((s) => s.expireStalePixCharges)
  const cancelPixSale = useStore((s) => s.cancelPixSale)
  const registerPixCharge = useStore((s) => s.registerPixCharge)
  const createChargeForSale = useStore((s) => s.createChargeForSale)
  const amortize = useStore((s) => s.amortize)
  const autoMatchSuggestions = useStore((s) => s.autoMatchSuggestions)
  const settleCashSales = useStore((s) => s.settleCashSales)
  const seedDemo = useStore((s) => s.seedDemo)
  const resetAll = useStore((s) => s.resetAll)

  const showToast = (msg: string) => {
    setToast(msg)
    window.setTimeout(() => setToast(null), 2800)
  }

  const activeRaffles = raffles.filter((r) => r.active)
  const currentRaffleId = saleRaffleId || activeRaffles[0]?.id || ''
  const myBlocks = useMemo(
    () =>
      blocks
        .filter((b) => b.raffleId === currentRaffleId && b.memberId === memberId)
        .sort((a, b) => a.index - b.index),
    [blocks, currentRaffleId, memberId],
  )
  const openBlock = myBlocks.find((b) => b.id === openBlockId) || null
  const myNumbers =
    memberId && currentRaffleId ? memberNumbers(memberId, currentRaffleId, openBlock?.id) : []
  const sold = currentRaffleId ? soldNumbers(currentRaffleId) : new Set<number>()
  const myOpenTotal = myBlocks.reduce((acc, b) => acc + blockStats(b.id).open, 0)

  const visibleSales = useMemo(() => {
    if (isAdmin) return sales
    return sales.filter((s) => s.memberId === memberId)
  }, [isAdmin, sales, memberId])

  const memberHomeBriefs = useMemo(() => {
    const lastAll = [...visibleSales].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    const pixAll = visibleSales
      .filter((s) => isPixToReview(s, pixCharges))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    const cashDue = visibleSales.filter(isCashPending)
    return {
      lastPreview: lastAll.slice(0, 2),
      lastAll,
      pixPreview: pixAll.slice(0, 2),
      pixAll,
      cashCount: cashDue.length,
      cashTotal: cashDue.reduce((sum, s) => sum + s.totalAmount, 0),
    }
  }, [visibleSales, pixCharges])

  const openMemberList = (tab: 'lista-vendas' | 'lista-pix') => {
    setOpenBlockId(null)
    setSelectedNumbers([])
    setMemberTab(tab)
  }

  /** Vendas que valem dinheiro — canceladas ficam só no histórico da lista. */
  const activeSales = useMemo(() => sales.filter((s) => !s.cancelledAt), [sales])

  const suggestions = useMemo(() => autoMatchSuggestions(), [sales, pixPayments, pixCharges, amortizations, autoMatchSuggestions])

  /** Números do painel: caixa, ritmo de venda, destaques de membro e comprador. */
  const resumo = useMemo(() => {
    const now = new Date()
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    const startOfWeek = startOfDay - 6 * 86_400_000
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime()
    const when = (s: (typeof activeSales)[number]) => new Date(s.createdAt).getTime()
    const value = (list: typeof activeSales) => list.reduce((a, s) => a + s.totalAmount, 0)
    const qty = (list: typeof activeSales) => list.reduce((a, s) => a + s.numbers.length, 0)
    const period = (from: number) => activeSales.filter((s) => when(s) >= from)

    const hoje = period(startOfDay)
    const semana = period(startOfWeek)
    const mes = period(startOfMonth)

    let emConta = 0
    let comVendedores = 0
    let pixAberto = 0
    for (const s of activeSales) {
      if (s.paymentMethod === 'pix' && (s.pixDestination || 'entidade') === 'entidade') {
        emConta += s.paidAmount
        pixAberto += Math.max(0, s.totalAmount - s.paidAmount)
      } else if (s.paymentMethod === 'dinheiro') {
        if ((s.cashDestination || 'vendedor') === 'loja' || s.cashSettledAt) {
          emConta += s.totalAmount
        } else {
          comVendedores += s.totalAmount
        }
      }
    }

    const eventos = raffles.filter((r) => r.active)
    const eventosBase = eventos.length ? eventos : raffles
    let totalNumeros = 0
    let vendidosQtd = 0
    let vendidosValor = 0
    let restanteQtd = 0
    let restanteValor = 0
    for (const r of eventosBase) {
      const rs = activeSales.filter((s) => s.raffleId === r.id)
      const vendidos = qty(rs)
      const restante = Math.max(0, r.totalNumbers - vendidos)
      totalNumeros += r.totalNumbers
      vendidosQtd += vendidos
      vendidosValor += value(rs)
      restanteQtd += restante
      restanteValor += restante * r.ticketPrice
    }

    const proximoSorteio = eventosBase
      .map((r) => parseDrawDate(r.drawDate))
      .filter((d): d is Date => Boolean(d))
      .sort((a, b) => a.getTime() - b.getTime())
      .find((d) => d.getTime() >= startOfDay)
    const diasSorteio = proximoSorteio
      ? Math.round((proximoSorteio.getTime() - startOfDay) / 86_400_000)
      : null

    const porMembro = members
      .map((m) => {
        const ms = activeSales.filter((s) => s.memberId === m.id)
        const st = memberBlockStats(m.id)
        return { name: m.name, vendidos: qty(ms), valor: value(ms), restam: st.openNumbers }
      })
      .filter((x) => x.vendidos > 0 || x.restam > 0)
    const maisVendeu = [...porMembro].sort((a, b) => b.vendidos - a.vendidos)[0] || null
    const menosVendeu =
      porMembro.length > 1 ? [...porMembro].sort((a, b) => a.vendidos - b.vendidos)[0] : null

    const liderDo = (list: typeof activeSales) => {
      const map = new Map<string, { name: string; vendidos: number; valor: number }>()
      for (const s of list) {
        const name = members.find((m) => m.id === s.memberId)?.name || '—'
        const cur = map.get(s.memberId) || { name, vendidos: 0, valor: 0 }
        cur.vendidos += s.numbers.length
        cur.valor += s.totalAmount
        map.set(s.memberId, cur)
      }
      return [...map.values()].sort((a, b) => b.vendidos - a.vendidos || b.valor - a.valor)[0] || null
    }

    const melhorTicket =
      members
        .map((m) => {
          const ms = activeSales.filter((s) => s.memberId === m.id)
          return {
            name: m.name,
            ticket: ms.length ? value(ms) / ms.length : 0,
            vendas: ms.length,
          }
        })
        .filter((x) => x.vendas > 0)
        .sort((a, b) => b.ticket - a.ticket)[0] || null

    const porComprador = new Map<string, { name: string; numeros: number; valor: number }>()
    for (const s of activeSales) {
      const key = s.buyerName.trim().toLowerCase() || '—'
      const cur = porComprador.get(key) || { name: s.buyerName.trim() || '—', numeros: 0, valor: 0 }
      cur.numeros += s.numbers.length
      cur.valor += s.totalAmount
      porComprador.set(key, cur)
    }
    const compradores = [...porComprador.values()]
    const maiorComprador = [...compradores].sort((a, b) => b.valor - a.valor)[0] || null
    const menorComprador =
      compradores.length > 1 ? [...compradores].sort((a, b) => a.valor - b.valor)[0] : null

    const totalValor = value(activeSales)
    return {
      hoje: { qtd: hoje.length, valor: value(hoje), lider: liderDo(hoje) },
      semana: { qtd: semana.length, valor: value(semana), lider: liderDo(semana) },
      mes: { qtd: mes.length, valor: value(mes), lider: liderDo(mes) },
      total: { qtd: activeSales.length, valor: totalValor },
      diasSorteio,
      proximoSorteio,
      emConta,
      aReceber: comVendedores + pixAberto,
      comVendedores,
      pixAberto,
      totalNumeros,
      vendidosQtd,
      vendidosValor,
      restanteQtd,
      restanteValor,
      maisVendeu,
      menosVendeu,
      maiorComprador,
      menorComprador,
      ticketMedio: activeSales.length ? totalValor / activeSales.length : 0,
      melhorTicket,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSales, raffles, members, blocks])

  const memberDraw = useMemo(() => {
    const local = parseDrawDate(raffles.find((r) => r.id === currentRaffleId)?.drawDate)
    if (local) {
      const start = new Date()
      start.setHours(0, 0, 0, 0)
      return {
        date: local,
        dias: Math.round((local.getTime() - start.getTime()) / 86_400_000),
      }
    }
    if (resumo.proximoSorteio && resumo.diasSorteio != null) {
      return { date: resumo.proximoSorteio, dias: resumo.diasSorteio }
    }
    return null
  }, [raffles, currentRaffleId, resumo.proximoSorteio, resumo.diasSorteio])

  const reports = useMemo(() => {
    return members
      .filter((m) => m.active)
      .map((m) => {
        const mSalesAll = activeSales.filter((s) => s.memberId === m.id)
        const mSales = reportEventId ? mSalesAll.filter((s) => s.raffleId === reportEventId) : mSalesAll
        const soldCount = mSales.reduce((acc, s) => acc + s.numbers.length, 0)
        const saleCount = mSales.length
        const expected = mSales.reduce((acc, s) => acc + s.totalAmount, 0)
        const received = mSales.reduce((acc, s) => acc + s.paidAmount, 0)
        const openAmount = Math.max(0, expected - received)
        const cashVendedor = mSales
          .filter((s) => s.paymentMethod === 'dinheiro' && (s.cashDestination || 'vendedor') === 'vendedor')
          .reduce((acc, s) => acc + s.totalAmount, 0)
        const cashLoja = mSales
          .filter((s) => s.paymentMethod === 'dinheiro' && s.cashDestination === 'loja')
          .reduce((acc, s) => acc + s.totalAmount, 0)
        const pixEntidade = mSales
          .filter((s) => s.paymentMethod === 'pix' && (s.pixDestination || 'entidade') === 'entidade')
          .reduce((acc, s) => acc + (s.status === 'quitado' ? s.paidAmount || s.totalAmount : 0), 0)
        const pixVendedor = mSales
          .filter((s) => s.paymentMethod === 'pix' && s.pixDestination === 'vendedor')
          .reduce((acc, s) => acc + s.paidAmount, 0)
        const cashPendingSales = mSales.filter((s) => isCashPending(s))
        const cashSettledSales = mSales.filter(
          (s) =>
            s.paymentMethod === 'dinheiro' &&
            (s.cashDestination || 'vendedor') === 'vendedor' &&
            Boolean(s.cashSettledAt),
        )
        const settlements = memberSettlements.filter(
          (x) =>
            x.memberId === m.id && (!reportEventId || !x.raffleId || x.raffleId === reportEventId),
        )
        const settledCash = cashSettledSales.reduce((a, s) => a + s.totalAmount, 0)
        const settledPix = settlements.filter((x) => x.kind === 'pix_vendedor').reduce((a, x) => a + x.amount, 0)
        const cashOpen = Math.max(0, Math.round(cashPendingSales.reduce((a, s) => a + s.totalAmount, 0) * 100) / 100)
        const pixSalesAmount = mSales.filter((s) => s.paymentMethod === 'pix').reduce((a, s) => a + s.totalAmount, 0)
        const cashSalesAmount = mSales.filter((s) => s.paymentMethod === 'dinheiro').reduce((a, s) => a + s.totalAmount, 0)
        const ticketPrice =
          (reportEventId
            ? raffles.find((r) => r.id === reportEventId)?.ticketPrice
            : raffles.find((r) => mSales.some((s) => s.raffleId === r.id))?.ticketPrice) || 0
        const uiCounts = { quitado: 0, pendente: 0, falha: 0 }
        for (const s of mSales) uiCounts[saleUiStatus(s, pixCharges)] += 1
        const dinheiroNaLoja = Math.round((cashLoja + pixEntidade + settledCash) * 100) / 100
        const byStatus = {
          quitado: uiCounts.quitado,
          pendente: uiCounts.pendente,
          parcial: mSales.filter((s) => s.status === 'parcial').length,
          divergente: mSales.filter((s) => s.status === 'divergente').length,
          falha: uiCounts.falha,
        }
        const withProof = mSales.filter((s) => Boolean(proofUrlForSale(s, pixCharges))).length
        const canceladas = sales.filter(
          (s) => s.memberId === m.id && s.cancelledAt && (!reportEventId || s.raffleId === reportEventId),
        )
        const cancMembro = canceladas.filter((s) => s.cancelReason === 'membro').length
        const cancTempo = canceladas.length - cancMembro
        const pixVendedorOpen = Math.max(0, Math.round((pixVendedor - settledPix) * 100) / 100)
        const bs = memberBlockStats(m.id, reportEventId || undefined)
        const memberBlocksList = blocks.filter(
          (b) => b.memberId === m.id && (!reportEventId || b.raffleId === reportEventId),
        )
        let unsoldValor = 0
        for (const b of memberBlocksList) {
          const st = blockStats(b.id)
          unsoldValor += st.open * (raffles.find((r) => r.id === b.raffleId)?.ticketPrice || 0)
        }
        const ticketMedio = saleCount ? expected / saleCount : 0
        return {
          member: m,
          mSales,
          cashPendingSales,
          settlements,
          saleCount,
          soldCount,
          expected,
          received,
          openAmount,
          cashVendedor,
          cashLoja,
          pixEntidade,
          pixVendedor,
          settledCash,
          settledPix,
          cashOpen,
          pixVendedorOpen,
          toEntity: dinheiroNaLoja,
          dinheiroNaLoja,
          pixSalesAmount,
          cashSalesAmount,
          ticketPrice,
          byStatus,
          withProof,
          cancMembro,
          cancTempo,
          dueTotal: cashOpen,
          unsoldNumbers: bs.openNumbers,
          unsoldValor: Math.round(unsoldValor * 100) / 100,
          ticketMedio,
        }
      })
      // Ranking: do maior vendedor para o menor
      .sort(
        (a, b) =>
          b.soldCount - a.soldCount || b.expected - a.expected || a.member.name.localeCompare(b.member.name),
      )
  }, [members, activeSales, sales, memberSettlements, reportEventId, pixCharges, raffles, blocks, memberBlockStats, blockStats])

  const selectedReport = useMemo(
    () => reports.find((r) => r.member.id === reportMemberId) || null,
    [reports, reportMemberId],
  )

  /** Números globais do evento escolhido (ou de todos) para os cartões do relatório. */
  const reportGlobals = useMemo(() => {
    const escolhidos = reportEventId ? raffles.filter((r) => r.id === reportEventId) : raffles
    const scoped = activeSales.filter((s) => !reportEventId || s.raffleId === reportEventId)
    let totalNumeros = 0
    let vendidosQtd = 0
    let aVenderValor = 0
    for (const r of escolhidos) {
      const vend = scoped
        .filter((s) => s.raffleId === r.id)
        .reduce((a, s) => a + s.numbers.length, 0)
      totalNumeros += r.totalNumbers
      vendidosQtd += vend
      aVenderValor += Math.max(0, r.totalNumbers - vend) * r.ticketPrice
    }
    const vendidoValor = scoped.reduce((a, s) => a + s.totalAmount, 0)
    const pixSales = scoped.filter((s) => s.paymentMethod === 'pix')
    const cashSales = scoped.filter((s) => s.paymentMethod === 'dinheiro')
    const pixPago = pixSales.filter(
      (s) =>
        (s.pixDestination || 'entidade') === 'entidade' &&
        (s.status === 'quitado' || (s.paidAmount || 0) > 0),
    )
    const pixRecebido = pixPago.reduce((a, s) => a + (s.paidAmount || s.totalAmount), 0)
    const pixNumeros = pixPago.reduce((a, s) => a + s.numbers.length, 0)
    const cashNaEntidade = cashSales.filter(
      (s) => (s.cashDestination || 'vendedor') === 'loja' || Boolean(s.cashSettledAt),
    )
    const cashPrestado = cashSales.filter((s) => Boolean(s.cashSettledAt))
    const dinheiroRecebido = cashPrestado.reduce((a, s) => a + s.totalAmount, 0)
    const dinheiroNumeros = cashPrestado.reduce((a, s) => a + s.numbers.length, 0)
    const recebido = pixRecebido + cashNaEntidade.reduce((a, s) => a + s.totalAmount, 0)
    const aPrestar = cashSales.filter((s) => isCashPending(s)).reduce((a, s) => a + s.totalAmount, 0)

    const eventNames = new Set(escolhidos.flatMap((r) => [r.eventName, r.name].filter(Boolean)))
    const contingenciaSaleIds = new Set(
      (auditLog || [])
        .filter((e) => e.action === 'venda.contingencia')
        .map((e) => e.ref?.saleId)
        .filter((id): id is string => Boolean(id)),
    )
    const countedContingencia = new Set<string>()
    let contingenciaNumeros = 0
    for (const s of scoped) {
      if (s.soldOffline || contingenciaSaleIds.has(s.id) || /contingenc/i.test(s.notes || '')) {
        countedContingencia.add(s.id)
        contingenciaNumeros += s.numbers.length
      }
    }
    for (const e of auditLog || []) {
      if (e.action !== 'venda.contingencia') continue
      const saleId = e.ref?.saleId
      if (saleId && countedContingencia.has(saleId)) continue
      const sale = saleId ? sales.find((s) => s.id === saleId) : undefined
      if (sale?.cancelledAt) continue
      if (reportEventId) {
        if (sale && sale.raffleId !== reportEventId) continue
        if (!sale && e.meta?.Evento && !eventNames.has(e.meta.Evento)) continue
      }
      if (sale) {
        if (saleId) countedContingencia.add(saleId)
        contingenciaNumeros += sale.numbers.length
        continue
      }
      const key = saleId || e.id
      if (countedContingencia.has(key)) continue
      countedContingencia.add(key)
      contingenciaNumeros += auditNumberQty(e)
    }
    const onlineNumeros = Math.max(0, vendidosQtd - contingenciaNumeros)

    const canceladas = sales.filter(
      (s) => s.cancelledAt && (!reportEventId || s.raffleId === reportEventId),
    )
    const porMembro = canceladas.filter((s) => s.cancelReason === 'membro')
    const porTempo = canceladas.filter((s) => s.cancelReason !== 'membro')

    return {
      esperado: aVenderValor,
      aVenderQtd: Math.max(0, totalNumeros - vendidosQtd),
      vendidoValor,
      recebido: Math.round(recebido * 100) / 100,
      aPrestar: Math.round(aPrestar * 100) / 100,
      pixRecebido: Math.round(pixRecebido * 100) / 100,
      dinheiroRecebido: Math.round(dinheiroRecebido * 100) / 100,
      pixNumeros,
      dinheiroNumeros,
      contingenciaNumeros,
      onlineNumeros,
      vendidosQtd,
      totalNumeros,
      cancMembro: {
        qtd: porMembro.length,
        numeros: porMembro.reduce((a, s) => a + s.numbers.length, 0),
        valor: porMembro.reduce((a, s) => a + s.totalAmount, 0),
      },
      cancTempo: {
        qtd: porTempo.length,
        numeros: porTempo.reduce((a, s) => a + s.numbers.length, 0),
        valor: porTempo.reduce((a, s) => a + s.totalAmount, 0),
      },
    }
  }, [activeSales, sales, raffles, reportEventId, auditLog])

  const baixaPendingSales = useMemo(() => {
    if (!baixaMemberId) return []
    return sales
      .filter((s) => s.memberId === baixaMemberId && isCashPending(s))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }, [sales, baixaMemberId])

  const baixaOpenTotal = useMemo(
    () => Math.round(baixaPendingSales.reduce((a, s) => a + s.totalAmount, 0) * 100) / 100,
    [baixaPendingSales],
  )

  const baixaQuitTotal = useMemo(
    () =>
      Math.round(
        baixaPendingSales.filter((s) => baixaSelectedIds.includes(s.id)).reduce((a, s) => a + s.totalAmount, 0) * 100,
      ) / 100,
    [baixaPendingSales, baixaSelectedIds],
  )

  const who = isAdmin
    ? getAuthRecord()?.organizerName || session?.memberName || 'ADM'
    : session?.memberName || 'Membro'

  const toggleNumber = (n: number) => {
    setSelectedNumbers((prev) => (prev.includes(n) ? prev.filter((x) => x !== n) : [...prev, n].sort((a, b) => a - b)))
  }

  // Sem rede: força dinheiro (PIX precisa da nuvem/Sicoob)
  useEffect(() => {
    if (offlineContingency && paymentMethod === 'pix') {
      setPaymentMethod('dinheiro')
    }
  }, [offlineContingency, paymentMethod])

  const onCreateSale = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!memberId && !isAdmin) return
    if (savingSale) return
    if (isSupabaseConfigured && !cloudOk && paymentMethod === 'pix') {
      showToast('Sem nuvem — PIX bloqueado. Use dinheiro (contingência) ou reconecte.')
      return
    }
    const formEl = e.currentTarget
    const fd = new FormData(formEl)
    const sellerId = isAdmin ? String(fd.get('memberId') || '') : memberId
    const raffleId = String(fd.get('raffleId') || currentRaffleId)
    const buyerName = String(fd.get('buyerName') || '').trim()
    const memberPix = !isAdmin && paymentMethod === 'pix'
    const memberCash = !isAdmin && paymentMethod === 'dinheiro'
    const resolvedPixDest: PixDestination = isAdmin && paymentMethod === 'pix' ? pixDestination : 'entidade'
    const resolvedCashDest: CashDestination = isAdmin && paymentMethod === 'dinheiro' ? cashDestination : 'vendedor'

    const file = (formEl.elements.namedItem('proofFile') as HTMLInputElement | null)?.files?.[0]
    const cloudSession = loadCloudSession()
    const cloudReady = isSupabaseConfigured && Boolean(cloudSession?.workspace.id)

    let proofPath: string | undefined
    let proofImageDataUrl: string | undefined
    if (file) {
      try {
        if (cloudReady) {
          const up = await uploadProofFile(crypto.randomUUID(), file)
          proofPath = up.path
        } else {
          proofImageDataUrl = proofDataUrl || (await fileToDataUrl(file))
        }
      } catch (err) {
        return showToast(err instanceof Error ? err.message : 'Não foi possível enviar o comprovante.')
      }
    }

    const ticketPrice = activeRaffles.find((r) => r.id === currentRaffleId)?.ticketPrice || 0
    const totalAmount = selectedNumbers.length * ticketPrice
    if (!(totalAmount > 0) || !selectedNumbers.length) {
      return showToast('Selecione ao menos um número.')
    }

    setSavingSale(true)
    let createdSaleId: string | null = null
    try {
      const notesRaw = String(fd.get('notes') || '').trim()
      const notes =
        offlineContingency && paymentMethod === 'dinheiro'
          ? [notesRaw, '[Contingência offline — sincroniza ao voltar a rede]'].filter(Boolean).join(' ')
          : notesRaw

      const result = addSale({
        raffleId,
        memberId: sellerId,
        buyerName,
        buyerPhone: String(fd.get('buyerPhone') || ''),
        numbers: selectedNumbers,
        paymentMethod,
        pixDestination: paymentMethod === 'pix' ? resolvedPixDest : undefined,
        cashDestination: paymentMethod === 'dinheiro' ? resolvedCashDest : undefined,
        notes,
        soldOffline: Boolean(offlineContingency && paymentMethod === 'dinheiro'),
        proofTxid: memberPix ? '' : String(fd.get('proofTxid') || ''),
        proofPath,
        proofImageDataUrl,
        receivedNow:
          memberCash ||
          (isAdmin && paymentMethod === 'dinheiro') ||
          (isAdmin && paymentMethod === 'pix' && String(fd.get('receivedNow') || '') === 'sim'),
        blockId: openBlockId || undefined,
      })
      if (!result.ok) return showToast(result.error)
      createdSaleId = result.sale.id

      if (memberPix || (isAdmin && paymentMethod === 'pix' && String(fd.get('receivedNow') || '') !== 'sim')) {
        let chargeCopy = ''
        let chargeTxid = ''
        let isDemo = true
        let expiresAt: string | undefined

        if (cloudReady && cloudSession?.role === 'member') {
          let pin = getStoredMemberPin(sellerId)
          if (!pin) {
            pin = window.prompt('Digite seu PIN para gerar o PIX da loja:')?.trim() || ''
            if (!pin) {
              removeSale(result.sale.id)
              showToast('PIX cancelado — venda não foi lançada. Informe o PIN para gerar o QR.')
              return
            }
          }
          try {
            await flushWorkspaceToCloud(useStore.getState().exportSnapshot())
          } catch (syncErr) {
            console.warn('Sync antes do PIX falhou; seguindo com sale no body', syncErr)
          }
          try {
            const remote = await createWorkspacePixCharge({
              accessCode: cloudSession.workspace.accessCode,
              memberId: sellerId,
              pin,
              saleId: result.sale.id,
              amount: totalAmount,
              buyerName,
              sale: result.sale,
            })
            isDemo = remote.provider !== 'sicoob'
            expiresAt = remote.expiresAt
            try {
              const opened = await fetchByAccessCode(cloudSession.workspace.accessCode)
              useStore.getState().importSnapshot(opened.state)
              syncCloudSessionMeta(opened.meta)
            } catch {
              registerPixCharge({
                id: remote.id,
                saleId: result.sale.id,
                txid: remote.txid,
                amount: remote.amount,
                copyPaste: remote.copyPaste,
                qrCode: remote.qrCode,
                provider: remote.provider,
                expiresAt: remote.expiresAt,
              })
            }
            chargeCopy = remote.copyPaste
            chargeTxid = remote.txid
          } catch (pixErr) {
            removeSale(result.sale.id)
            createdSaleId = null
            try {
              await flushWorkspaceToCloud(useStore.getState().exportSnapshot())
            } catch {
              /* ignore */
            }
            showToast(pixErr instanceof Error ? pixErr.message : 'Erro ao gerar PIX — venda não lançada.')
            return
          }
        } else {
          const local = createChargeForSale(result.sale.id, totalAmount)
          if (local.ok) {
            chargeCopy = local.charge.copyPaste || local.charge.txid
            chargeTxid = local.charge.txid
            expiresAt = local.charge.expiresAt
          } else {
            removeSale(result.sale.id)
            showToast(local.error || 'Não foi possível gerar PIX.')
            return
          }
        }

        if (!chargeCopy) {
          removeSale(result.sale.id)
          showToast('Não foi possível gerar o QR do PIX — venda não lançada.')
          return
        }

        logAudit(
          'venda.pix_gerada',
          `${buyerName} · ${brl(totalAmount)} · nº ${formatNumbers(selectedNumbers)}`,
          {
            'Forma de pagamento': 'PIX (conta da loja)',
            Comprador: buyerName,
            Números: formatNumbers(selectedNumbers),
            Quantidade: `${selectedNumbers.length}`,
            Valor: brl(totalAmount),
            TXID: chargeTxid,
            Provedor: isDemo ? 'Simulado (sem Sicoob)' : 'Sicoob',
            'QR válido até': expiresAt ? new Date(expiresAt).toLocaleString('pt-BR') : '30 min',
            Vendedor: members.find((m) => m.id === sellerId)?.name || who,
            Evento: raffles.find((r) => r.id === raffleId)?.eventName,
            Situação: 'Aguardando pagamento',
          },
          { saleId: result.sale.id, txid: chargeTxid },
        )
        setPixPaid(false)
        setPixModal({
          buyerName,
          amount: totalAmount,
          copyPaste: chargeCopy,
          txid: chargeTxid,
          saleId: result.sale.id,
          isDemo,
          expiresAt:
            expiresAt || new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        })
        // Mantém a tela de venda aberta até pagar ou cancelar
        return
      }

      formEl.reset()
      setSelectedNumbers([])
      setPaymentMethod('dinheiro')
      setCashDestination('vendedor')
      setPixDestination('entidade')
      setProofDataUrl('')

      const saleMeta = {
        'Forma de pagamento': memberCash ? 'Dinheiro' : 'PIX',
        Situação: memberCash
          ? resolvedCashDest === 'loja'
            ? 'Quitado — dinheiro entregue na loja'
            : 'Quitado — dinheiro com o vendedor'
          : 'PIX efetivado',
        Comprador: buyerName,
        Números: formatNumbers(selectedNumbers),
        Quantidade: `${selectedNumbers.length}`,
        Valor: brl(totalAmount),
        Recebimento: memberCash
          ? `Dinheiro (${resolvedCashDest === 'loja' ? 'entregue na loja' : 'com o vendedor'})`
          : `PIX (${resolvedPixDest === 'entidade' ? 'conta da loja' : 'chave do vendedor'})`,
        Evento: raffles.find((r) => r.id === raffleId)?.eventName,
        Vendedor: members.find((m) => m.id === sellerId)?.name || who,
      }

      if (memberCash) {
        if (offlineContingency) {
          showToast('Contingência: venda em dinheiro salva neste celular. Sobe pra nuvem quando a rede voltar.')
          logAudit(
            'venda.contingencia',
            `${buyerName} · ${brl(totalAmount)}`,
            { ...saleMeta, Envio: 'Salva offline — sobe quando a rede voltar' },
            { saleId: result.sale.id },
          )
        } else {
          showToast('Venda em dinheiro registrada. Ficou com você — preste contas à entidade.')
          logAudit('venda.dinheiro', `${buyerName} · ${brl(totalAmount)}`, saleMeta, {
            saleId: result.sale.id,
          })
        }
      } else {
        showToast(proofPath ? 'Venda registrada (comprovante na nuvem).' : 'Venda registrada.')
        logAudit(
          'venda.registrar',
          `${buyerName} · ${brl(totalAmount)}`,
          {
            ...saleMeta,
            Comprovante: proofPath ? 'Imagem anexada' : undefined,
            TXID: String(fd.get('proofTxid') || '') || undefined,
          },
          { saleId: result.sale.id },
        )
      }
    } catch (err) {
      if (createdSaleId && memberPix) {
        removeSale(createdSaleId)
      }
      showToast(err instanceof Error ? err.message : 'Erro ao salvar venda')
    } finally {
      setSavingSale(false)
    }
  }

  /** Limpa a tela de venda para o próximo comprador, sem tocar no PIX em aberto. */
  const clearSaleForm = () => {
    saleFormRef.current?.reset()
    setSelectedNumbers([])
    setPaymentMethod('dinheiro')
    setCashDestination('vendedor')
    setPixDestination('entidade')
    setProofDataUrl('')
  }

  /** Pede o motivo antes de cancelar — o texto fica na venda e na auditoria. */
  const askCancelReason = (saleId: string, fromModal: boolean) => {
    setCancelAsk({ saleId, fromModal })
  }

  const confirmCancelPix = async (reason: string) => {
    const ask = cancelAsk
    if (!ask) return
    setCancelBusy(true)
    try {
      const sale = sales.find((s) => s.id === ask.saleId)
      const result = cancelPixSale(ask.saleId, 'membro', { note: reason, by: who })
      if (!result.ok) {
        setCancelAsk(null)
        return showToast(result.error)
      }
      if (ask.fromModal || pixModal?.saleId === ask.saleId) {
        setPixModal(null)
        setPixPaid(false)
        clearSaleForm()
      }
      setCancelAsk(null)
      logAudit(
        'venda.pix_cancelada',
        `${sale?.buyerName || 'comprador'} · nº ${formatNumbers(result.numbers)} · motivo: ${reason}`,
        {
          Situação: 'Cancelado pelo membro',
          Motivo: reason,
          'Forma de pagamento': 'PIX (não foi pago)',
          Comprador: sale?.buyerName,
          Números: formatNumbers(result.numbers),
          Quantidade: `${result.numbers.length}`,
          Valor: sale ? brl(sale.totalAmount) : undefined,
          TXID: pixCharges.find((c) => c.saleId === ask.saleId)?.txid,
          'Cancelado por': who,
        },
        { saleId: ask.saleId },
      )
      try {
        await flushWorkspaceToCloud(useStore.getState().exportSnapshot())
      } catch {
        /* sobe no próximo sync */
      }
      showToast(`PIX cancelado. Números ${formatNumbers(result.numbers)} liberados.`)
    } finally {
      setCancelBusy(false)
    }
  }

  /** Deixa o PIX valendo em segundo plano e libera a tela para a próxima venda. */
  const keepPixAndStartNewSale = () => {
    setPixModal(null)
    setPixPaid(false)
    clearSaleForm()
    showToast('PIX segue em aberto. Reabra pelo status "Aguardando PIX" na lista.')
  }

  /** Reabre o mesmo QR/copia e cola de uma venda que já está aguardando. */
  const reopenPixCharge = (saleId: string) => {
    const sale = sales.find((s) => s.id === saleId)
    const charge = pixCharges.find((c) => c.saleId === saleId && c.status === 'pending')
    const copyPaste = charge?.copyPaste || charge?.qrCode || ''
    if (!sale || !charge || !copyPaste) {
      return showToast('O QR desta venda não está salvo neste aparelho. Cancele e gere um PIX novo.')
    }
    if (isPixChargeExpired(charge)) {
      return showToast('Este QR já venceu. Cancele a venda e gere um PIX novo.')
    }
    setPixPaid(false)
    setPixModal({
      buyerName: sale.buyerName,
      amount: sale.totalAmount,
      copyPaste,
      txid: charge.txid,
      saleId: sale.id,
      isDemo: charge.provider ? charge.provider !== 'sicoob' : true,
      expiresAt: charge.expiresAt,
      reopened: true,
    })
  }

  const finishPaidPixSale = () => {
    const buyer = pixModal?.buyerName
    const amount = pixModal?.amount
    const txid = pixModal?.txid
    const sale = sales.find((s) => s.id === pixModal?.saleId)
    setPixModal(null)
    setPixPaid(false)
    setSelectedNumbers([])
    setPaymentMethod('dinheiro')
    setProofDataUrl('')
    if (buyer && amount != null) {
      showToast(`Venda PIX para ${buyer} no valor ${brl(amount)} recebida com sucesso.`)
      logAudit(
        'venda.pix',
        `${buyer} · ${brl(amount)}`,
        {
          'Forma de pagamento': 'PIX',
          Situação: 'PIX efetivado',
          Comprador: buyer,
          Valor: brl(amount),
          TXID: txid,
          Recebimento: 'PIX na conta da loja',
          Números: sale ? formatNumbers(sale.numbers) : undefined,
          Quantidade: sale ? `${sale.numbers.length}` : undefined,
          Vendedor: who,
        },
        { saleId: sale?.id, txid },
      )
    }
  }

  const confirmCashSettlement = async (adminPassword: string, memberPin: string) => {
    const member = members.find((m) => m.id === baixaMemberId)
    if (!member) {
      setBaixaConfirmError('Membro não encontrado. Selecione de novo.')
      return
    }

    // A lista pode ter mudado por sync enquanto o modal estava aberto
    const stillPending = useStore
      .getState()
      .sales.filter((s) => baixaSelectedIds.includes(s.id) && s.memberId === member.id && isCashPending(s))
    if (!stillPending.length) {
      setBaixaConfirmError('Essas vendas já foram baixadas ou mudaram. Feche e marque de novo.')
      return
    }

    setSettlingBaixa(true)
    setBaixaConfirmError(null)
    try {
      try {
        await verifyAdminCredential(adminPassword)
      } catch (err) {
        setBaixaConfirmError(formatErr(err, 'Senha do ADM inválida.'))
        return
      }

      const expectedPin = String(member.pin || '').trim()
      if (!expectedPin) {
        setBaixaConfirmError('Este membro não tem PIN cadastrado. Edite o membro antes de baixar.')
        return
      }
      if (memberPin.trim() !== expectedPin) {
        setBaixaConfirmError('PIN do membro incorreto.')
        return
      }

      const result = settleCashSales({
        memberId: member.id,
        saleIds: stillPending.map((s) => s.id),
        memberName: member.name,
      })
      if (!result.ok) {
        setBaixaConfirmError(result.error)
        return
      }

      setBaixaSelectedIds([])
      setBaixaConfirmOpen(false)
      logAudit('dinheiro.liquidar', `${member.name} · ${brl(result.amount)}`, {
        'Forma de pagamento': 'Dinheiro',
        Situação: 'Dinheiro prestado (conta da loja)',
        Membro: member.name,
        Valor: brl(result.amount),
        Vendas: `${stillPending.length} venda(s)`,
        Compradores: stillPending.map((s) => s.buyerName).join(', '),
        Números: formatNumbers(stillPending.flatMap((s) => s.numbers)),
        Recebimento: 'Dinheiro prestado à loja',
        'Assinado por': `ADM ${who} + PIN de ${member.name}`,
      })
      try {
        await flushWorkspaceToCloud(useStore.getState().exportSnapshot())
        showToast(`Liquidado ${brl(result.amount)} — baixado e assinado por todos.`)
      } catch (syncErr) {
        console.warn('Baixa salva local, falha ao subir', syncErr)
        showToast(`Liquidado ${brl(result.amount)} localmente. Sobe para a nuvem no próximo sync.`)
      }
    } finally {
      setSettlingBaixa(false)
    }
  }

  const confirmWipeAll = async (adminPassword: string) => {
    setWipeBusy(true)
    setWipeError(null)
    try {
      try {
        await verifyAdminCredential(adminPassword)
      } catch (err) {
        setWipeError(formatErr(err, 'Senha do ADM inválida.'))
        return
      }
      const before = {
        membros: members.length,
        eventos: raffles.length,
        vendas: sales.length,
      }
      resetAll()
      // Roda depois do reset: o rastro sobrevive à limpeza
      logAudit(
        'dados.limpar',
        `Apagou ${before.eventos} evento(s), ${before.membros} membro(s) e ${before.vendas} venda(s)`,
        {
          Eventos: `${before.eventos}`,
          Membros: `${before.membros}`,
          Vendas: `${before.vendas}`,
          Autorizado: `Senha do ADM ${who}`,
          Observação: 'O rastro de ações foi mantido',
        },
      )
      setWipeOpen(false)
      requestCloudPush()
      showToast('Dados limpos. O rastro de ações foi preservado.')
    } finally {
      setWipeBusy(false)
    }
  }

  const closeSensitiveOp = () => {
    setSensitiveOp(null)
    setSensitiveError(null)
    setSensitiveBusy(false)
  }

  const confirmSensitiveOp = async (adminPassword: string) => {
    if (!sensitiveOp) return
    setSensitiveBusy(true)
    setSensitiveError(null)
    try {
      try {
        await verifyAdminCredential(adminPassword)
      } catch (err) {
        setSensitiveError(formatErr(err, 'Senha do ADM inválida.'))
        return
      }

      const autorizado = `ADM ${who}`

      if (sensitiveOp.type === 'liberar') {
        const block = blocks.find((b) => b.id === sensitiveOp.blockId)
        const member = members.find((m) => m.id === sensitiveOp.memberId)
        if (!block || !member) {
          setSensitiveError('Bloco ou membro não encontrado.')
          return
        }
        const bs = blockStats(block.id)
        const result = unassignBlock(block.id)
        if (!result.ok) {
          setSensitiveError(result.error || 'Não foi possível liberar.')
          return
        }
        logAudit('bloco.liberar', `${block.label} · de ${member.name}`, {
          Bloco: `${block.label} (nº ${block.fromNumber}–${block.toNumber})`,
          De: member.name,
          Situação: `${bs.open} de ${bs.total} nº ainda abertos`,
          Evento: raffles.find((r) => r.id === block.raffleId)?.eventName,
          'Confirmado por': autorizado,
        })
        requestCloudPush()
        showToast(`Bloco ${block.label} liberado.`)
        closeSensitiveOp()
        return
      }

      if (sensitiveOp.type === 'removerMembro') {
        const member = members.find((m) => m.id === sensitiveOp.memberId)
        if (!member) {
          setSensitiveError('Membro não encontrado.')
          return
        }
        const memberBlocks = blocks.filter((b) => b.memberId === member.id)
        const st = memberBlockStats(member.id)
        removeMember(member.id)
        logAudit('membro.remover', member.name, {
          Membro: member.name,
          WhatsApp: member.phone || undefined,
          'Blocos que tinha': memberBlocks.map((b) => b.label).join(', ') || 'nenhum',
          'Números vendidos': `${st.soldNumbers}`,
          'Confirmado por': autorizado,
        })
        requestCloudPush()
        showToast(`Membro ${member.name} removido.`)
        closeSensitiveOp()
        return
      }

      if (sensitiveOp.type === 'removerEvento') {
        const raffle = raffles.find((r) => r.id === sensitiveOp.raffleId)
        if (!raffle) {
          setSensitiveError('Evento não encontrado.')
          return
        }
        const eventBlocks = blocks.filter((b) => b.raffleId === raffle.id)
        removeRaffle(raffle.id)
        logAudit('evento.remover', raffle.eventName, {
          Evento: raffle.eventName,
          Blocos: `${raffle.blockCount || eventBlocks.length}`,
          'Total de números': `${raffle.totalNumbers}`,
          'Vendas do evento': `${activeSales.filter((s) => s.raffleId === raffle.id).length}`,
          'Confirmado por': autorizado,
        })
        setOpenEventId(null)
        requestCloudPush()
        showToast(`Evento ${raffle.eventName} removido.`)
        closeSensitiveOp()
        return
      }

      if (sensitiveOp.type === 'transferir') {
        const toMember = members.find((m) => m.id === sensitiveOp.toMemberId)
        if (!toMember) {
          setSensitiveError('Membro de destino não encontrado.')
          return
        }
        const movedBlocks = blocks.filter((b) => sensitiveOp.blockIds.includes(b.id))
        let ok = 0
        for (const blockId of sensitiveOp.blockIds) {
          const result = transferBlock(blockId, toMember.id)
          if (!result.ok) {
            setSensitiveError(result.error || 'Erro ao transferir.')
            return
          }
          ok += 1
        }
        const movedLabels = movedBlocks
          .map((b) => `${b.label} (de ${members.find((m) => m.id === b.memberId)?.name || 'livre'})`)
          .join(', ')
        setTransferBlockIds([])
        logAudit(
          'bloco.transferir',
          `${movedLabels || `${ok} bloco(s)`} → ${toMember.name}`,
          {
            Blocos: movedBlocks.map((b) => b.label).join(', '),
            Quantidade: `${ok} bloco(s)`,
            De: [
              ...new Set(movedBlocks.map((b) => members.find((m) => m.id === b.memberId)?.name || 'livre')),
            ].join(', '),
            Para: toMember.name,
            'Números abertos': `${movedBlocks.reduce((acc, b) => acc + blockStats(b.id).open, 0)}`,
            'Confirmado por': autorizado,
          },
        )
        requestCloudPush()
        showToast(ok === 1 ? 'Transferência registrada.' : `${ok} transferências registradas.`)
        closeSensitiveOp()
        return
      }

      const toMember = members.find((m) => m.id === sensitiveOp.memberId)
      if (!toMember) {
        setSensitiveError('Membro não encontrado.')
        return
      }
      let ok = 0
      for (const blockId of sensitiveOp.blockIds) {
        const result = assignBlock(blockId, toMember.id)
        if (!result.ok) {
          setSensitiveError(result.error || 'Erro ao atribuir.')
          return
        }
        ok += 1
      }
      const assignedLabels = blocks
        .filter((b) => sensitiveOp.blockIds.includes(b.id))
        .map((b) => b.label)
        .join(', ')
      setAssignBlockIds([])
      logAudit(
        'bloco.atribuir',
        `${assignedLabels || `${ok} bloco(s)`} → ${toMember.name}`,
        {
          Blocos: assignedLabels,
          Quantidade: `${ok} bloco(s)`,
          Para: toMember.name,
          Evento: raffles.find((r) => r.id === (filterEventId || raffles[0]?.id))?.eventName,
          'Confirmado por': autorizado,
        },
      )
      requestCloudPush()
      showToast(ok === 1 ? 'Bloco atribuído ao membro.' : `${ok} blocos atribuídos ao membro.`)
      closeSensitiveOp()
    } finally {
      setSensitiveBusy(false)
    }
  }

  const verifyPixPayment = async (txid: string, saleId?: string, opts?: { silent?: boolean }) => {
    const silent = Boolean(opts?.silent)
    const cloudSession = loadCloudSession()
    if (!cloudSession || cloudSession.role !== 'member') {
      if (!silent) showToast('Verificação PIX só funciona com sessão de membro na nuvem.')
      return
    }
    if (pixCheckLock.current) return
    const sellerId = memberId || cloudSession.memberId
    let pin = getStoredMemberPin(sellerId)
    if (!pin) {
      if (silent) return
      pin = window.prompt('Digite seu PIN para consultar o pagamento:')?.trim() || ''
      if (!pin) return
    }
    pixCheckLock.current = true
    setCheckingPix(true)
    try {
      const result = await checkWorkspacePixCharge({
        accessCode: cloudSession.workspace.accessCode,
        memberId: sellerId,
        pin,
        txid,
      })
      if (result.status === 'paid') {
        const settled = settlePixChargeByTxid(txid, result.amount, result.saleId || saleId)
        if (settled.ok && settled.reactivated) {
          showToast('Atenção: este PIX estava cancelado e o pagamento entrou. Avise o ADM.')
          logAudit(
            'venda.pix_pago_apos_cancelar',
            txid,
            {
              'Forma de pagamento': 'PIX',
              Situação: 'PIX efetivado (entrou depois do cancelamento)',
              TXID: txid,
            },
            { saleId: result.saleId || saleId, txid },
          )
        }
        try {
          const remote = await fetchByAccessCode(cloudSession.workspace.accessCode)
          useStore.getState().importSnapshot(remote.state)
          syncCloudSessionMeta(remote.meta)
        } catch {
          /* local já quitado */
        }
        setPixPaid(true)
        // Com modal aberto a mensagem fica na tela de sucesso; fora dela, toast na lista
        if (!pixModal) {
          const name =
            sales.find((s) => s.id === (result.saleId || saleId))?.buyerName || 'comprador'
          const value = result.amount ?? 0
          showToast(`Venda PIX para ${name} no valor ${brl(value)} recebida com sucesso.`)
        }
        return
      }
      if (!silent) showToast(result.message || `Ainda pendente no Sicoob (${result.status}).`)
    } catch (err) {
      if (!silent) showToast(err instanceof Error ? err.message : 'Falha ao verificar PIX')
    } finally {
      pixCheckLock.current = false
      setCheckingPix(false)
    }
  }

  const syncPixChargesFromCloud = async () => {
    const cloudSession = loadCloudSession()
    if (!cloudSession?.workspace.accessCode || !isSupabaseConfigured) return
    try {
      const remote = await listWorkspacePixCharges(cloudSession.workspace.accessCode)
      if (!remote.length) return
      useStore.setState((s) => {
        const byTxid = new Map(s.pixCharges.map((c) => [c.txid.toLowerCase(), c]))
        for (const r of remote) {
          const key = String(r.txid || '').toLowerCase()
          if (!key) continue
          const prev = byTxid.get(key)
          const status = r.status === 'paid' ? ('paid' as const) : ('pending' as const)
          byTxid.set(key, {
            id: prev?.id || r.id,
            saleId: r.saleId || prev?.saleId || '',
            txid: r.txid,
            amount: Number(r.amount),
            status,
            createdAt: r.createdAt || prev?.createdAt || new Date().toISOString(),
            paidAt: r.paidAt || prev?.paidAt,
            copyPaste: r.copyPaste || prev?.copyPaste,
            qrCode: r.copyPaste || prev?.qrCode,
            provider: r.provider || prev?.provider,
            expiresAt: r.expiresAt || prev?.expiresAt,
          })
          if (status === 'paid' && r.saleId) {
            const sale = s.sales.find((x) => x.id === r.saleId)
            if (sale && sale.status !== 'quitado') {
              // será ajustado abaixo via settle — aqui só merge charges
            }
          }
        }
        let salesNext = s.sales
        for (const r of remote) {
          if (r.status !== 'paid' || !r.saleId) continue
          salesNext = salesNext.map((sale) => {
            if (sale.id !== r.saleId || sale.status === 'quitado') return sale
            const paidAmount = Math.min(sale.totalAmount, Math.max(sale.paidAmount, Number(r.amount) || sale.totalAmount))
            const status: PaymentStatus =
              paidAmount + 0.001 >= sale.totalAmount ? 'quitado' : paidAmount > 0 ? 'parcial' : 'pendente'
            return { ...sale, paidAmount, status }
          })
        }
        return { pixCharges: [...byTxid.values()], sales: salesNext }
      })
    } catch (err) {
      console.warn('Falha ao listar TXIDs na nuvem', err)
    }
  }

  useEffect(() => {
    if (!pixModal || pixModal.isDemo || !pixModal.txid || pixPaid) return
    void verifyPixPayment(pixModal.txid, pixModal.saleId, { silent: true })
    const id = window.setInterval(() => {
      void verifyPixPayment(pixModal.txid, pixModal.saleId, { silent: true })
    }, 1000)
    return () => window.clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pixModal?.txid, pixModal?.saleId, pixModal?.isDemo, pixPaid])

  // Se a nuvem/webhook já quitou a venda, fecha o aguardo sem botão manual
  useEffect(() => {
    if (!pixModal?.saleId || pixPaid) return
    const sale = sales.find((s) => s.id === pixModal.saleId)
    const charge = pixCharges.find((c) => c.saleId === pixModal.saleId && c.status === 'paid')
    if (sale?.status === 'quitado' || charge) setPixPaid(true)
  }, [pixModal?.saleId, pixPaid, sales, pixCharges])

  // Pendentes na lista: consulta automática sem botão (o do modal tem effect próprio)
  useEffect(() => {
    if (isAdmin) return
    const pending = sales.filter(
      (s) =>
        s.memberId === memberId &&
        s.paymentMethod === 'pix' &&
        s.status === 'pendente' &&
        !s.cancelledAt &&
        s.id !== pixModal?.saleId &&
        pixCharges.some((c) => c.saleId === s.id && c.status === 'pending' && c.txid && !isPixChargeExpired(c)),
    )
    if (!pending.length) return
    const tick = () => {
      for (const s of pending) {
        const c = pixCharges.find((x) => x.saleId === s.id && x.txid)
        if (c?.txid) void verifyPixPayment(c.txid, s.id, { silent: true })
      }
    }
    tick()
    const id = window.setInterval(tick, 1500)
    return () => window.clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, pixModal?.saleId, sales, pixCharges, memberId])

  useEffect(() => {
    if (!isAdmin || adminTab !== 'txid') return
    void syncPixChargesFromCloud()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, adminTab])

  // QR vencido: venda vira "Cancelada" (fica no histórico riscada) e os números voltam.
  // Roda também no ADM: se o celular do membro estiver fechado, o número ficaria preso.
  useEffect(() => {
    const tick = () => {
      const expired = expireStalePixCharges()
      if (!expired.length) return
      const freed = useStore
        .getState()
        .sales.filter((s) => expired.includes(s.id))
        .flatMap((s) => s.numbers)
        .sort((a, b) => a - b)
      setPixModal((prev) => (prev?.saleId && expired.includes(prev.saleId) ? null : prev))
      logAudit(
        'venda.pix_expirada',
        `${expired.length} venda(s) cancelada(s) por tempo${freed.length ? ` · nº ${formatNumbers(freed)} liberado(s)` : ''}`,
        {
          Situação: 'PIX cancelado por tempo (expirou)',
          Motivo: 'Passou o prazo do PIX sem o comprador pagar',
          'Forma de pagamento': 'PIX (não foi pago)',
          Vendas: `${expired.length}`,
          Compradores: useStore
            .getState()
            .sales.filter((s) => expired.includes(s.id))
            .map((s) => s.buyerName)
            .join(', '),
          TXID: useStore
            .getState()
            .pixCharges.filter((c) => c.saleId && expired.includes(c.saleId))
            .map((c) => c.txid)
            .join(', '),
          Números: freed.length ? `${formatNumbers(freed)} (liberados)` : undefined,
        },
      )
      showToast(
        freed.length
          ? `PIX expirou sem pagamento. Números ${formatNumbers(freed)} liberados.`
          : 'PIX expirou sem pagamento. Venda cancelada.',
      )
      if (isAdmin) requestCloudPush()
      else void flushWorkspaceToCloud(useStore.getState().exportSnapshot()).catch(() => {})
    }
    tick()
    const id = window.setInterval(tick, 15_000)
    return () => window.clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, expireStalePixCharges])

  if (!session) {
    return (
      <div className="auth-shell">
        <div className="panel auth-card">
          <p>Sessão expirada.</p>
          <button className="btn btn-primary" type="button" onClick={() => window.location.reload()}>
            Entrar de novo
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand-block">
          <p className="brand">RifaPIX</p>
          <p>
            {isAdmin ? 'Administrador' : 'Membro'} · <strong>{who}</strong>
          </p>
        </div>
        <div className="top-actions">
          <div className="nav-scroll">
            <nav className="nav" aria-label="Menu principal">
              {isAdmin
                ? (
                    [
                      ['painel', 'Painel', 'Painel'],
                      ['equipe', 'Equipe', 'Equipe'],
                      ['transferencias', 'Transferências', 'Transf.'],
                      ['eventos', 'Eventos', 'Eventos'],
                      ['vendas', 'Vendas', 'Vendas'],
                      ['txid', 'TXID', 'TXID'],
                      ['amortizacao', 'Baixas', 'Baixas'],
                      ['relatorios', 'Relatórios', 'Relat.'],
                      ['auditoria', 'Auditoria', 'Audit.'],
                    ] as const
                  ).map(([id, full, short]) => (
                    <button
                      key={id}
                      type="button"
                      className={adminTab === id ? 'active' : ''}
                      onClick={() => setAdminTab(id)}
                    >
                      <span className="nav-label-full">{full}</span>
                      <span className="nav-label-short">{short}</span>
                    </button>
                  ))
                : (
                    [
                      ['blocos', 'Meus blocos', 'Blocos'],
                      ['vendas', 'Minhas vendas', 'Vendas'],
                    ] as const
                  ).map(([id, full, short]) => (
                    <button
                      key={id}
                      type="button"
                      className={
                        id === 'blocos'
                          ? memberTab === 'blocos' && !openBlock
                            ? 'active'
                            : ''
                          : memberTab === 'vendas' || (id === 'vendas' && openBlock)
                            ? 'active'
                            : ''
                      }
                      onClick={() => {
                        if (id === 'blocos') {
                          setOpenBlockId(null)
                          setSelectedNumbers([])
                          setMemberTab('blocos')
                          return
                        }
                        setMemberTab('vendas')
                      }}
                    >
                      <span className="nav-label-full">{full}</span>
                      <span className="nav-label-short">{short}</span>
                    </button>
                  ))}
            </nav>
          </div>
          <InstallAppButton />
          <button
            type="button"
            className="btn btn-secondary btn-sair"
            onClick={async () => {
              saveCloudSession(null)
              logout()
              if (isSupabaseConfigured && supabase) await supabase.auth.signOut()
              window.location.reload()
            }}
          >
            Sair
          </button>
        </div>
      </header>

      {!isAdmin && (
        <aside
          className={`draw-countdown ${
            memberDraw == null
              ? ''
              : memberDraw.dias <= 30
                ? 'prazo-urgente'
                : memberDraw.dias <= 60
                  ? 'prazo-atencao'
                  : 'prazo-tranquilo'
          }`}
        >
          <span>Dias para o sorteio</span>
          <strong>{memberDraw == null ? '—' : memberDraw.dias}</strong>
          {memberDraw ? (
            <b className="prazo-data">{formatDrawDate(memberDraw.date)}</b>
          ) : (
            <em>sem data de sorteio neste evento</em>
          )}
        </aside>
      )}

      {/* MEMBER VIEW */}
      {!isAdmin && memberTab === 'blocos' && !openBlock && (
        <div className="member-briefs">
          <section className="member-brief">
            <div className="member-brief-head">
              <h3>Últimas vendas</h3>
              {memberHomeBriefs.lastAll.length > 2 && (
                <button type="button" className="btn btn-ghost btn-mini" onClick={() => openMemberList('lista-vendas')}>
                  Ver todas
                </button>
              )}
            </div>
            {memberHomeBriefs.lastPreview.length === 0 ? (
              <p>Nenhuma venda ainda.</p>
            ) : (
              <ul>
                {memberHomeBriefs.lastPreview.map((s) => (
                  <li key={s.id}>
                    <button type="button" className="member-brief-row" onClick={() => openMemberList('lista-vendas')}>
                      <b>{s.buyerName}</b>
                      <span>
                        {s.cancelledAt ? 'Cancelada · ' : ''}
                        {s.paymentMethod === 'pix' ? 'PIX' : 'Dinheiro'} · {brl(s.totalAmount)}
                      </span>
                      <small>
                        {formatNumbers(s.numbers)} · {new Date(s.createdAt).toLocaleDateString('pt-BR')}
                      </small>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="member-brief member-brief-pix">
            <div className="member-brief-head">
              <h3>PIX a revisar</h3>
              {memberHomeBriefs.pixAll.length > 2 && (
                <button type="button" className="btn btn-ghost btn-mini" onClick={() => openMemberList('lista-pix')}>
                  Ver todos
                </button>
              )}
            </div>
            <p className="member-brief-hint">
              Aguardando pagamento ou cancelado por tempo — confira se o copia e cola foi enviado.
            </p>
            {memberHomeBriefs.pixPreview.length === 0 ? (
              <p>Nenhum PIX pendente ou expirado.</p>
            ) : (
              <ul>
                {memberHomeBriefs.pixPreview.map((s) => {
                  const charge = pixCharges.find((c) => c.saleId === s.id)
                  const expired = s.cancelReason === 'expirado' || isPixChargeExpired(charge)
                  const waiting = !expired && !s.cancelledAt && s.status === 'pendente'
                  const canReopen = waiting && Boolean(charge?.copyPaste || charge?.qrCode)
                  return (
                    <li key={s.id}>
                      <b>{s.buyerName}</b>
                      <span>
                        {waiting ? 'Aguardando' : 'Expirado / tempo'} · {brl(s.totalAmount)}
                      </span>
                      <small>{formatNumbers(s.numbers)}</small>
                      {waiting && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-mini"
                          onClick={() => reopenPixCharge(s.id)}
                          disabled={!canReopen}
                        >
                          Ver QR
                        </button>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
          <section className="member-brief member-brief-cash">
            <h3>Dinheiro a prestar</h3>
            <p className="member-brief-hint">Vendas em espécie ainda sem baixa da tesouraria.</p>
            {memberHomeBriefs.cashCount === 0 ? (
              <p>Nada a prestar no momento.</p>
            ) : (
              <p className="member-brief-total">
                {memberHomeBriefs.cashCount} venda{memberHomeBriefs.cashCount === 1 ? '' : 's'}
                <strong>{brl(memberHomeBriefs.cashTotal)}</strong>
              </p>
            )}
          </section>
        </div>
      )}

      {!isAdmin && memberTab === 'blocos' && !openBlock && (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Meus blocos</h2>
              <p>
                Toque em um bloco para vender os números. Em aberto no total: <strong>{myOpenTotal}</strong>
              </p>
            </div>
            <label>
              Evento/rifa
              <select
                value={currentRaffleId}
                onChange={(e) => {
                  setSaleRaffleId(e.target.value)
                  setSelectedNumbers([])
                  setOpenBlockId(null)
                }}
              >
                {activeRaffles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.eventName} — {r.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="block-grid">
            {myBlocks.length === 0 && <p className="empty">Nenhum bloco atribuído a você neste evento.</p>}
            {myBlocks.map((b) => {
              const st = blockStats(b.id)
              const soldOut = st.open === 0
              return (
                <button
                  key={b.id}
                  type="button"
                  className={`block-card ${soldOut ? 'sold-out' : 'has-open'}`}
                  onClick={() => {
                    setOpenBlockId(b.id)
                    setSelectedNumbers([])
                    setMemberTab('vendas')
                  }}
                >
                  <strong>{b.label}</strong>
                  <span className="hint">
                    nº {String(b.fromNumber).padStart(2, '0')}–{String(b.toNumber).padStart(2, '0')}
                  </span>
                  <span className="block-open">{st.open} abertos</span>
                  <span className="hint">
                    {st.sold}/{st.total} vendidos
                  </span>
                </button>
              )
            })}
          </div>
        </section>
      )}

      {!isAdmin && (memberTab === 'vendas' || openBlock) && (
        <section className="grid-2">
          <form className="panel" ref={saleFormRef} onSubmit={onCreateSale}>
            <div className="panel-head">
              <div>
                <h2>{openBlock ? `Vender · ${openBlock.label}` : 'Lançar venda'}</h2>
                <p>
                  {openBlock
                    ? `${String(openBlock.fromNumber).padStart(2, '0')}–${String(openBlock.toNumber).padStart(2, '0')} · ${blockStats(openBlock.id).open} abertos`
                    : 'Abra um bloco em “Meus blocos” para vender com segurança.'}
                </p>
              </div>
              {openBlock && (
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => {
                    setOpenBlockId(null)
                    setSelectedNumbers([])
                    setMemberTab('blocos')
                  }}
                >
                  Voltar aos blocos
                </button>
              )}
            </div>
            {!openBlock ? (
              <p className="empty">Escolha um bloco primeiro para ver os números disponíveis.</p>
            ) : (
              <>
                <div className="form-grid">
                  <input type="hidden" name="raffleId" value={currentRaffleId} />
                  <label>
                    Comprador
                    <input name="buyerName" required />
                  </label>
                  <label>
                    WhatsApp
                    <input name="buyerPhone" />
                  </label>
                  <label className="full">
                    Forma de recebimento
                    {offlineContingency ? (
                      <span className="contingency-flag"> EM CONTINGÊNCIA — SEM REDE</span>
                    ) : null}
                    <select
                      value={paymentMethod}
                      onChange={(e) => setPaymentMethod(e.target.value as PaymentMethod)}
                      required
                      disabled={offlineContingency}
                    >
                      <option value="dinheiro">Dinheiro</option>
                      <option value="pix" disabled={offlineContingency}>
                        PIX{offlineContingency ? ' (precisa de nuvem)' : ''}
                      </option>
                    </select>
                  </label>
                  {!isAdmin && !offlineContingency && paymentMethod === 'dinheiro' && (
                    <p className="hint full payment-rule">
                      O dinheiro fica com você. Depois você presta contas à entidade nos relatórios do ADM.
                    </p>
                  )}
                  {!isAdmin && !offlineContingency && paymentMethod === 'pix' && (
                    <p className="hint full payment-rule">
                      PIX sempre na conta da loja. Ao salvar, abrimos o QR e o copia-e-cola para enviar ao comprador.
                    </p>
                  )}
                  {isAdmin && paymentMethod === 'dinheiro' && (
                    <label className="full">
                      Destino do dinheiro
                      <select
                        value={cashDestination}
                        onChange={(e) => setCashDestination(e.target.value as CashDestination)}
                        required
                      >
                        <option value="vendedor">Ficou comigo (vendedor)</option>
                        <option value="loja">Já foi pra loja / entidade</option>
                      </select>
                    </label>
                  )}
                  {isAdmin && paymentMethod === 'pix' && (
                    <label className="full">
                      PIX caiu em qual conta?
                      <select value={pixDestination} onChange={(e) => setPixDestination(e.target.value as PixDestination)} required>
                        <option value="entidade">Conta da entidade</option>
                        <option value="vendedor">Minha conta (vendedor)</option>
                      </select>
                    </label>
                  )}
                  {isAdmin && paymentMethod === 'pix' && (
                    <label className="full">
                      Já recebeu este PIX?
                      <select name="receivedNow" defaultValue="nao">
                        <option value="nao">Ainda não (fica pendente)</option>
                        <option value="sim">Sim, já caiu</option>
                      </select>
                    </label>
                  )}
                  {isAdmin && (
                    <label className="full">
                      TXID / End-to-end (opcional)
                      <input name="proofTxid" placeholder="Do comprovante, se tiver" />
                    </label>
                  )}
                  {isAdmin && (
                    <label className="full">
                      Comprovante (imagem ou PDF, opcional)
                      <input
                        name="proofFile"
                        type="file"
                        accept="image/*,application/pdf"
                        onChange={async (ev) => {
                          const file = ev.target.files?.[0]
                          if (!file) {
                            setProofDataUrl('')
                            return
                          }
                          try {
                            setProofDataUrl(await fileToDataUrl(file))
                          } catch {
                            setProofDataUrl('')
                            showToast('Não foi possível ler o comprovante.')
                          }
                        }}
                      />
                    </label>
                  )}
                  <label className="full">
                    Observações (opcional)
                    <textarea name="notes" />
                  </label>
                </div>
                <NumberGrid numbers={myNumbers} sold={sold} selected={new Set(selectedNumbers)} onToggle={toggleNumber} />
                <div className="btn-row">
                  <button
                    className="btn btn-primary"
                    type="submit"
                    disabled={!selectedNumbers.length || savingSale || (offlineContingency && paymentMethod === 'pix')}
                  >
                    {savingSale
                      ? 'Salvando…'
                      : offlineContingency && paymentMethod === 'pix'
                        ? 'PIX bloqueado sem nuvem'
                        : offlineContingency
                          ? `Salvar em contingência (${selectedNumbers.length} nº · ${brl(selectedNumbers.length * (activeRaffles.find((r) => r.id === currentRaffleId)?.ticketPrice || 0))})`
                          : `Salvar venda (${selectedNumbers.length} nº · ${brl(selectedNumbers.length * (activeRaffles.find((r) => r.id === currentRaffleId)?.ticketPrice || 0))})`}
                  </button>
                </div>
                {myBlocks.filter((b) => b.id !== openBlock.id).length > 0 && (
                  <div className="other-blocks">
                    <p className="hint">Outros blocos</p>
                    <div className="other-blocks-grid">
                      {myBlocks
                        .filter((b) => b.id !== openBlock.id)
                        .map((b) => {
                          const st = blockStats(b.id)
                          const soldOut = st.open === 0
                          return (
                            <button
                              key={b.id}
                              type="button"
                              className={`other-block-chip ${soldOut ? 'sold-out' : 'has-open'}`}
                              onClick={() => {
                                setOpenBlockId(b.id)
                                setSelectedNumbers([])
                                setMemberTab('vendas')
                              }}
                            >
                              <strong>{b.label}</strong>
                              <span>
                                {st.open} ab.
                              </span>
                            </button>
                          )
                        })}
                    </div>
                  </div>
                )}
              </>
            )}
          </form>
          <div className="panel">
            <div className="panel-head">
              <div>
                <h2>Minhas vendas</h2>
              </div>
              {memberHomeBriefs.lastAll.length > 2 && (
                <button type="button" className="btn btn-ghost btn-mini" onClick={() => openMemberList('lista-vendas')}>
                  Ver todas
                </button>
              )}
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Comprador</th>
                    <th>Números</th>
                    <th>Recebimento</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {memberHomeBriefs.lastPreview.map((s) => {
                    const charge = pixCharges.find((c) => c.saleId === s.id)
                    const cancelled = Boolean(s.cancelledAt)
                    const waitingPix =
                      !cancelled &&
                      s.paymentMethod === 'pix' &&
                      s.status === 'pendente' &&
                      !isPixChargeExpired(charge)
                    const canReopen = waitingPix && Boolean(charge?.copyPaste || charge?.qrCode)
                    // QR já venceu mas a venda ainda não foi marcada: não deixa dizer "aguardando"
                    const pixVencido =
                      !cancelled &&
                      s.paymentMethod === 'pix' &&
                      s.status === 'pendente' &&
                      isPixChargeExpired(charge)
                    return (
                      <tr key={s.id} className={cancelled ? 'sale-cancelled' : undefined}>
                        <td>{s.buyerName}</td>
                        <td>{formatNumbers(s.numbers)}</td>
                        <td>
                          {s.paymentMethod === 'dinheiro'
                            ? 'Dinheiro (com você · prestar contas)'
                            : 'PIX (conta da loja)'}
                          <div className="hint">
                            {brl(s.totalAmount)}
                            {charge?.txid ? (
                              <>
                                <br />
                                TXID: <code>{charge.txid}</code>
                              </>
                            ) : null}
                            {waitingPix ? (
                              <>
                                <br />
                                <span className="pix-pending-hint">Aguardando pagamento…</span>
                              </>
                            ) : pixVencido ? (
                              <>
                                <br />
                                <span className="pix-pending-hint">
                                  Prazo do PIX venceu — números liberados
                                </span>
                              </>
                            ) : null}
                          </div>
                        </td>
                        <td>
                          {waitingPix ? (
                            <div className="sale-status-actions">
                              <button
                                type="button"
                                className="badge badge-action falha"
                                onClick={() => (canReopen ? reopenPixCharge(s.id) : undefined)}
                                disabled={!canReopen}
                                title={
                                  canReopen
                                    ? 'Abrir de novo o QR e o copia e cola desta venda'
                                    : 'QR não disponível neste aparelho'
                                }
                              >
                                Aguardando PIX
                              </button>
                              <button
                                type="button"
                                className="btn btn-ghost btn-mini"
                                onClick={() => askCancelReason(s.id, false)}
                              >
                                Cancelar
                              </button>
                            </div>
                          ) : cancelled ? (
                            <div className="sale-status-actions">
                              <span className="badge falha">{cancelInfo(s, charge)?.label}</span>
                              <InfoPopover
                                label="Ver motivo"
                                title={cancelInfo(s, charge)?.label || 'Cancelamento'}
                                tone="falha"
                                lines={[
                                  cancelInfo(s, charge)?.reason,
                                  `Em ${new Date(s.cancelledAt as string).toLocaleString('pt-BR')}`,
                                ]}
                              />
                            </div>
                          ) : pixVencido ? (
                            <span className="badge falha">Pagamento expirado</span>
                          ) : (
                            <span className={`badge ${s.status}`}>{statusLabel[s.status]}</span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      {!isAdmin && (memberTab === 'lista-vendas' || memberTab === 'lista-pix') && (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>{memberTab === 'lista-pix' ? 'PIX a revisar' : 'Minhas vendas'}</h2>
              <p>
                {memberTab === 'lista-pix'
                  ? 'Somente PIX aguardando pagamento ou cancelado por tempo.'
                  : 'Todas as suas vendas, da mais recente para a mais antiga.'}
              </p>
            </div>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                setOpenBlockId(null)
                setSelectedNumbers([])
                setMemberTab('blocos')
              }}
            >
              Voltar
            </button>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Comprador</th>
                  <th>Números</th>
                  <th>Recebimento</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {(memberTab === 'lista-pix' ? memberHomeBriefs.pixAll : memberHomeBriefs.lastAll).map((s) => {
                  const charge = pixCharges.find((c) => c.saleId === s.id)
                  const cancelled = Boolean(s.cancelledAt)
                  const waitingPix =
                    !cancelled &&
                    s.paymentMethod === 'pix' &&
                    s.status === 'pendente' &&
                    !isPixChargeExpired(charge)
                  const canReopen = waitingPix && Boolean(charge?.copyPaste || charge?.qrCode)
                  const pixVencido =
                    !cancelled &&
                    s.paymentMethod === 'pix' &&
                    s.status === 'pendente' &&
                    isPixChargeExpired(charge)
                  return (
                    <tr key={s.id} className={cancelled ? 'sale-cancelled' : undefined}>
                      <td>{s.buyerName}</td>
                      <td>{formatNumbers(s.numbers)}</td>
                      <td>
                        {s.paymentMethod === 'dinheiro'
                          ? 'Dinheiro (com você · prestar contas)'
                          : 'PIX (conta da loja)'}
                        <div className="hint">
                          {brl(s.totalAmount)}
                          {charge?.txid ? (
                            <>
                              <br />
                              TXID: <code>{charge.txid}</code>
                            </>
                          ) : null}
                          {waitingPix ? (
                            <>
                              <br />
                              <span className="pix-pending-hint">Aguardando pagamento…</span>
                            </>
                          ) : pixVencido ? (
                            <>
                              <br />
                              <span className="pix-pending-hint">Prazo do PIX venceu — números liberados</span>
                            </>
                          ) : null}
                        </div>
                      </td>
                      <td>
                        {waitingPix ? (
                          <div className="sale-status-actions">
                            <button
                              type="button"
                              className="badge badge-action falha"
                              onClick={() => (canReopen ? reopenPixCharge(s.id) : undefined)}
                              disabled={!canReopen}
                            >
                              Aguardando PIX
                            </button>
                            <button
                              type="button"
                              className="btn btn-ghost btn-mini"
                              onClick={() => askCancelReason(s.id, false)}
                            >
                              Cancelar
                            </button>
                          </div>
                        ) : cancelled ? (
                          <div className="sale-status-actions">
                            <span className="badge falha">{cancelInfo(s, charge)?.label}</span>
                            <InfoPopover
                              label="Ver motivo"
                              title={cancelInfo(s, charge)?.label || 'Cancelamento'}
                              tone="falha"
                              lines={[
                                cancelInfo(s, charge)?.reason,
                                `Em ${new Date(s.cancelledAt as string).toLocaleString('pt-BR')}`,
                              ]}
                            />
                          </div>
                        ) : pixVencido ? (
                          <span className="badge falha">Pagamento expirado</span>
                        ) : (
                          <span className={`badge ${s.status}`}>{statusLabel[s.status]}</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ADMIN */}
      {isAdmin && adminTab === 'painel' && (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Painel ADM</h2>
              <p>Cadastre equipe e faixas, depois cada membro vende só os números dele.</p>
            </div>
            <div className="btn-row" style={{ marginTop: 0 }}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  if (!askProceed()) return
                  seedDemo()
                  logAudit('dados.demo', 'Carregou dados de demonstração')
                  requestCloudPush()
                  showToast('Demo: 4 blocos×50. Carlos PIN 1234 (blocos 1–2), Fernanda PIN 5678 (3–4).')
                }}
              >
                Carregar demo
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => {
                  setWipeError(null)
                  setWipeOpen(true)
                }}
              >
                Limpar
              </button>
            </div>
          </div>
          {isSupabaseConfigured && loadCloudSession()?.workspace.accessCode ? (
            <div className="invite-link-box">
              <h3>Link de acesso da equipe</h3>
              <p className="hint">
                Envie este link aos membros (substitui digitar código). No 1º open no celular, a equipe já fica
                vinculada.
              </p>
              <code className="invite-link">
                {`${window.location.origin}${import.meta.env.BASE_URL || '/rifa-pix/'}?equipe=${loadCloudSession()!.workspace.accessCode}`}
              </code>
              <div className="btn-row">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={async () => {
                    const link = `${window.location.origin}${import.meta.env.BASE_URL || '/rifa-pix/'}?equipe=${loadCloudSession()!.workspace.accessCode}`
                    try {
                      await navigator.clipboard.writeText(link)
                      showToast('Link copiado.')
                    } catch {
                      showToast(link)
                    }
                  }}
                >
                  Copiar link
                </button>
              </div>
            </div>
          ) : null}
          <h3>Resumo</h3>
          <div className="summary-grid">
            <article className="summary-card summary-solo summary-solo--membros">
              <span>Membros cadastrados</span>
              <strong>{members.length}</strong>
            </article>
            <div className="summary-group summary-group--vendas">
              <article className="summary-card pink-1">
                <span>Vendas hoje</span>
                <strong>{resumo.hoje.qtd}</strong>
                <em>
                  {brl(resumo.hoje.valor)}
                  {resumo.hoje.lider ? ` · ${resumo.hoje.lider.name}` : ''}
                </em>
              </article>
              <article className="summary-card pink-2">
                <span>Vendas na semana</span>
                <strong>{resumo.semana.qtd}</strong>
                <em>
                  {brl(resumo.semana.valor)} · últimos 7 dias
                  {resumo.semana.lider ? ` · ${resumo.semana.lider.name}` : ''}
                </em>
              </article>
              <article className="summary-card pink-3">
                <span>Vendas no mês</span>
                <strong>{resumo.mes.qtd}</strong>
                <em>
                  {brl(resumo.mes.valor)}
                  {resumo.mes.lider ? ` · ${resumo.mes.lider.name}` : ''}
                </em>
              </article>
              <article className="summary-card pink-4">
                <span>Vendas no total</span>
                <strong>{resumo.total.qtd}</strong>
                <em>{brl(resumo.total.valor)}</em>
              </article>
            </div>
            <article
              className={`summary-card summary-solo summary-solo--prazo ${
                resumo.diasSorteio == null
                  ? ''
                  : resumo.diasSorteio <= 30
                    ? 'prazo-urgente'
                    : resumo.diasSorteio <= 60
                      ? 'prazo-atencao'
                      : 'prazo-tranquilo'
              }`}
            >
              <span>Dias para o sorteio</span>
              <strong>{resumo.diasSorteio == null ? '—' : resumo.diasSorteio}</strong>
              {resumo.proximoSorteio ? (
                <b className="prazo-data">{formatDrawDate(resumo.proximoSorteio)}</b>
              ) : (
                <em>sem data de sorteio</em>
              )}
            </article>
            <div className="summary-group summary-group--caixa">
              <article className="summary-card">
                <span>Valores em conta</span>
                <strong>
                  {brl(resumo.emConta)} <small>{pct(resumo.emConta, resumo.total.valor)}</small>
                </strong>
                <em>do vendido · PIX da loja + dinheiro já prestado</em>
              </article>
              <article className="summary-card">
                <span>Valores a receber</span>
                <strong>
                  {brl(resumo.aReceber)} <small>{pct(resumo.aReceber, resumo.total.valor)}</small>
                </strong>
                <em>
                  {brl(resumo.comVendedores)} com vendedores · {brl(resumo.pixAberto)} PIX em aberto
                </em>
              </article>
            </div>
            <div className="summary-group summary-group--equipe">
              <article className="summary-card">
                <span>Membro que mais vendeu</span>
                <strong>{resumo.maisVendeu?.name || '—'}</strong>
                <em>
                  {resumo.maisVendeu
                    ? `${resumo.maisVendeu.vendidos} nº vendidos · faltam ${resumo.maisVendeu.restam} nº`
                    : 'sem vendas'}
                </em>
              </article>
              <article className="summary-card">
                <span>Membro que menos vendeu</span>
                <strong>{resumo.menosVendeu?.name || '—'}</strong>
                <em>
                  {resumo.menosVendeu
                    ? `${resumo.menosVendeu.vendidos} nº vendidos · faltam ${resumo.menosVendeu.restam} nº`
                    : 'precisa de 2+ membros'}
                </em>
              </article>
            </div>
            <div className="summary-group summary-group--numeros">
              <article className="summary-card">
                <span>Números vendidos</span>
                <strong>
                  {resumo.vendidosQtd} <small>{pct(resumo.vendidosQtd, resumo.totalNumeros)}</small>
                </strong>
                <em>{brl(resumo.vendidosValor)} do total de {resumo.totalNumeros} nº</em>
              </article>
              <article className="summary-card">
                <span>Números a vender</span>
                <strong>
                  {resumo.restanteQtd} <small>{pct(resumo.restanteQtd, resumo.totalNumeros)}</small>
                </strong>
                <em>{brl(resumo.restanteValor)} a arrecadar</em>
              </article>
            </div>
            <div className="summary-group summary-group--compradores">
              <article className="summary-card">
                <span>Maior comprador</span>
                <strong>{resumo.maiorComprador?.name || '—'}</strong>
                <em>
                  {resumo.maiorComprador
                    ? `${resumo.maiorComprador.numeros} nº · ${brl(resumo.maiorComprador.valor)}`
                    : 'sem compradores'}
                </em>
              </article>
              <article className="summary-card">
                <span>Menor comprador</span>
                <strong>{resumo.menorComprador?.name || '—'}</strong>
                <em>
                  {resumo.menorComprador
                    ? `${resumo.menorComprador.numeros} nº · ${brl(resumo.menorComprador.valor)}`
                    : 'precisa de 2+ compradores'}
                </em>
              </article>
            </div>
            <article className="summary-card summary-solo summary-solo--ticket">
              <span>Ticket médio geral</span>
              <strong>{brl(resumo.ticketMedio)}</strong>
              {resumo.melhorTicket ? (
                <b className="ticket-lider">
                  {resumo.melhorTicket.name} · {brl(resumo.melhorTicket.ticket)}
                </b>
              ) : (
                <em>por venda registrada</em>
              )}
            </article>
          </div>
          {suggestions.length > 0 && <h3>Sugestões TXID</h3>}
          {suggestions.map((s) => {
            const sale = sales.find((x) => x.id === s.saleId)
            const pix = pixPayments.find((x) => x.id === s.pixPaymentId)
            return (
              <div className="suggest-item" key={`${s.saleId}-${s.pixPaymentId}`}>
                <div>
                  <strong>{sale?.buyerName}</strong> ← {pix?.payerName}
                  <div className="hint">
                    {brl(s.amount)} · {s.reason}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    const r = amortize(s.saleId, s.pixPaymentId, s.amount, 'Conferência TXID')
                    showToast(r.ok ? 'Baixa aplicada.' : r.error || 'Erro')
                    if (r.ok) requestCloudPush()
                  }}
                >
                  Amortizar
                </button>
              </div>
            )
          })}
          <h3>Rastro de ações</h3>
          <p className="hint">
            Últimas 10 ações. Histórico completo, busca e exportação na aba{' '}
            <button type="button" className="btn-link" onClick={() => setAdminTab('auditoria')}>
              Auditoria
            </button>
            .
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Quando</th>
                  <th>Quem</th>
                  <th>Ação</th>
                  <th>Detalhe</th>
                  <th>
                    Detalhes
                    <div className="th-hint">passe o mouse / toque</div>
                  </th>
                </tr>
              </thead>
              <tbody>
                {(auditLog || []).length === 0 && (
                  <tr>
                    <td colSpan={5}>
                      <p className="empty">Nenhuma ação registrada ainda.</p>
                    </td>
                  </tr>
                )}
                {(auditLog || []).slice(0, 10).map((a) => (
                  <tr key={a.id}>
                    <td>{new Date(a.at).toLocaleString('pt-BR')}</td>
                    <td>{a.actorName}</td>
                    <td>{auditActionLabel[a.action] || a.action}</td>
                    <td>{a.detail || '—'}</td>
                    <td>
                      <InfoPopover
                        label="Ver detalhes"
                        title={auditActionLabel[a.action] || a.action}
                        lines={[
                          ...auditPopoverLines(a, liveAuditSituacao(a, sales, pixCharges)),
                          `Quem: ${a.actorName}`,
                          `Quando: ${new Date(a.at).toLocaleString('pt-BR')}`,
                        ]}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {isAdmin && adminTab === 'equipe' && (
        <section className="grid-2">
          <form
            className="panel"
            onSubmit={async (e) => {
              e.preventDefault()
              const fd = new FormData(e.currentTarget)
              const name = String(fd.get('name') || '')
              const phone = String(fd.get('phone') || '')
              const pin = String(fd.get('pin') || '')
              const wantFull = fullAccess
              const email = String(fd.get('adminEmail') || '').trim()
              const tempPassword = String(fd.get('tempPassword') || '')

              if (wantFull) {
                if (!askProceed('Criar este membro com acesso total (ADM)?')) return
                if (!email.includes('@')) return showToast('Informe o e-mail do acesso total.')
                if (tempPassword.length < 6) return showToast('Senha provisória com no mínimo 6 caracteres.')
              }

              const result = addMember({ name, phone, pin })
              if (!result.ok) return showToast(result.error)

              if (wantFull) {
                const cloud = loadCloudSession()
                if (!cloud?.workspace.id) {
                  showToast('Membro criado, mas sem nuvem para liberar acesso total.')
                  e.currentTarget.reset()
                  setFullAccess(false)
                  return
                }
                try {
                  await createWorkspaceAdmin({
                    workspaceId: cloud.workspace.id,
                    displayName: result.member.name,
                    email,
                    password: tempPassword,
                  })
                  logAudit('membro.acesso_total', `${result.member.name} · ${email}`, {
                    Membro: result.member.name,
                    WhatsApp: phone || undefined,
                    'Acesso total': 'Sim — também é ADM da equipe',
                    'E-mail de login': email,
                    Senha: 'Provisória, troca obrigatória no 1º login',
                  })
                  showToast(
                    `Membro ${result.member.name} criado com acesso total. No 1º login com e-mail, deve trocar a senha.`,
                  )
                } catch (err) {
                  logAudit('membro.criar', result.member.name, {
                    Membro: result.member.name,
                    WhatsApp: phone || undefined,
                    'Acesso total': `Tentou liberar e falhou: ${err instanceof Error ? err.message : 'erro'}`,
                  })
                  showToast(
                    `Membro criado, mas falhou o acesso total: ${err instanceof Error ? err.message : 'erro'}`,
                  )
                }
              } else {
                logAudit('membro.criar', result.member.name, {
                  Membro: result.member.name,
                  WhatsApp: phone || undefined,
                  'Acesso total': 'Não — só vende pelos blocos',
                })
                showToast(`Membro ${result.member.name} criado.`)
              }
              e.currentTarget.reset()
              setFullAccess(false)
              requestCloudPush()
            }}
          >
            <div className="panel-head">
              <div>
                <h2>Cadastrar membro</h2>
                <p>PIN para vender nos blocos. Marque acesso total se também for ADM da equipe.</p>
              </div>
            </div>
            <div className="form-grid">
              <label>
                Nome
                <input name="name" required />
              </label>
              <label>
                WhatsApp
                <input name="phone" />
              </label>
              <label className="full">
                PIN (mín. 4) — login como membro
                <input name="pin" required minLength={4} inputMode="numeric" />
              </label>
              <label className="check-row full">
                <input type="checkbox" checked={fullAccess} onChange={(e) => setFullAccess(e.target.checked)} />
                Acesso total (ADM da mesma equipe)
              </label>
              {fullAccess ? (
                <>
                  <label className="full">
                    E-mail (login Administrador)
                    <input name="adminEmail" type="email" required={fullAccess} autoComplete="off" />
                  </label>
                  <label className="full">
                    Senha provisória (troca obrigatória no 1º login)
                    <input
                      name="tempPassword"
                      type="password"
                      required={fullAccess}
                      minLength={6}
                      autoComplete="new-password"
                    />
                  </label>
                  <p className="hint full">
                    Entra em <strong>Administrador</strong> com e-mail/senha. No primeiro acesso o sistema exige troca
                    de senha.
                  </p>
                </>
              ) : null}
            </div>
            <div className="btn-row">
              <button className="btn btn-primary" type="submit">
                Salvar membro
              </button>
            </div>
          </form>

          <form
            className="panel"
            onSubmit={(e) => {
              e.preventDefault()
              const fd = new FormData(e.currentTarget)
              const memberIdSel = String(fd.get('memberId') || '')
              if (!assignBlockIds.length) return showToast('Selecione ao menos um bloco.')
              if (!memberIdSel) return showToast('Selecione o membro.')
              setSensitiveError(null)
              setSensitiveOp({ type: 'atribuir', memberId: memberIdSel, blockIds: [...assignBlockIds] })
            }}
          >
            <div className="panel-head">
              <div>
                <h2>Atribuir bloco livre</h2>
                <p>Verde = livre. Cinza = já atribuído. Vermelho = vendido (não mexe). Selecione só os livres.</p>
              </div>
            </div>
            <div className="form-grid">
              <label className="full">
                Evento
                <select
                  value={filterEventId || raffles[0]?.id || ''}
                  onChange={(e) => {
                    setFilterEventId(e.target.value)
                    setAssignBlockIds([])
                  }}
                >
                  {raffles.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.eventName}
                    </option>
                  ))}
                </select>
              </label>
              <div className="full">
                <span className="field-label">Blocos do evento</span>
                <div className="transfer-block-list">
                  {blocks
                    .filter((b) => b.raffleId === (filterEventId || raffles[0]?.id))
                    .sort((a, b) => a.index - b.index)
                    .map((b) => {
                      const st = blockStats(b.id)
                      const assigned = Boolean(b.memberId)
                      const soldOut = st.open <= 0
                      const owner = members.find((m) => m.id === b.memberId)?.name || 'livre'
                      const selected = assignBlockIds.includes(b.id)
                      const locked = assigned || soldOut
                      return (
                        <button
                          key={b.id}
                          type="button"
                          className={`transfer-block ${
                            soldOut ? 'sold-out' : assigned ? 'assigned' : 'free'
                          } ${selected ? 'selected' : ''}`}
                          disabled={locked}
                          onClick={() => {
                            if (locked) return
                            setAssignBlockIds((prev) =>
                              prev.includes(b.id) ? prev.filter((id) => id !== b.id) : [...prev, b.id],
                            )
                          }}
                        >
                          <strong>{b.label}</strong>
                          <span>
                            {b.fromNumber}–{b.toNumber} · {owner}
                          </span>
                          <span>{soldOut ? '\u00a0' : assigned ? 'Indisponível' : `${st.open} abertos`}</span>
                          {soldOut ? <span className="vendido-stamp">VENDIDO!</span> : null}
                        </button>
                      )
                    })}
                </div>
                {!assignBlockIds.length && <p className="hint">Selecione um ou mais blocos livres (verde).</p>}
                {assignBlockIds.length > 0 && (
                  <p className="hint">{assignBlockIds.length} bloco(s) selecionado(s).</p>
                )}
              </div>
              <label className="full">
                Para o membro
                <select name="memberId" required defaultValue="">
                  <option value="" disabled>
                    Selecione
                  </option>
                  {members.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="btn-row">
              <button className="btn btn-primary" type="submit" disabled={!assignBlockIds.length}>
                Atribuir {assignBlockIds.length > 1 ? `blocos (${assignBlockIds.length})` : 'bloco'}
              </button>
            </div>
          </form>

          <div className="panel" style={{ gridColumn: '1 / -1' }}>
            <div className="panel-head">
              <div>
                <h2>Membros e eventos</h2>
              </div>
              <label>
                Filtrar evento
                <select value={filterEventId} onChange={(e) => setFilterEventId(e.target.value)}>
                  <option value="">Todos</option>
                  {raffles.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.eventName}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="member-cards">
              {members.map((m) => {
                const memberBlocks = blocks.filter((b) => b.memberId === m.id && (!filterEventId || b.raffleId === filterEventId))
                const events = [
                  ...new Set(
                    memberBlocks
                      .map((b) => raffles.find((r) => r.id === b.raffleId)?.eventName)
                      .filter(Boolean),
                  ),
                ] as string[]
                const st = memberBlockStats(m.id, filterEventId || undefined)
                return (
                  <article key={m.id} className="member-card">
                    <div className="member-card-head">
                      <strong>{m.name}</strong>
                      <button
                        type="button"
                        className="btn btn-mini btn-ghost"
                        onClick={() => {
                          setEditMemberError(null)
                          setEditMemberId(m.id)
                        }}
                      >
                        Editar
                      </button>
                    </div>
                    <div className="hint">PIN {m.pin}</div>
                    <div className="hint">
                      Eventos: {events.length ? events.join(', ') : 'nenhum bloco neste filtro'}
                    </div>
                    <div className="hint">
                      {st.blocks} blocos · {st.openBlocks} com aberto · {st.soldOutBlocks} esgotados · {st.openNumbers} nº livres
                    </div>
                    <div className="mini-blocks">
                      {memberBlocks
                        .sort((a, b) => a.index - b.index)
                        .map((b) => {
                          const bs = blockStats(b.id)
                          const soldOut = bs.open <= 0
                          return (
                            <div key={b.id} className={`mini-block ${soldOut ? 'sold-out' : 'has-open'}`}>
                              {b.label} · {bs.open}/{bs.total}
                              {soldOut ? (
                                <span className="mini-vendido">VENDIDO!</span>
                              ) : (
                                <button
                                  type="button"
                                  className="btn btn-ghost"
                                  onClick={() => {
                                    setSensitiveError(null)
                                    setSensitiveOp({ type: 'liberar', blockId: b.id, memberId: m.id })
                                  }}
                                >
                                  liberar
                                </button>
                              )}
                            </div>
                          )
                        })}
                    </div>
                    <button
                      type="button"
                      className="btn btn-danger"
                      onClick={() => {
                        setSensitiveError(null)
                        setSensitiveOp({ type: 'removerMembro', memberId: m.id })
                      }}
                    >
                      Remover membro
                    </button>
                  </article>
                )
              })}
            </div>
          </div>
        </section>
      )}

      {isAdmin && adminTab === 'transferencias' && (
        <section className="grid-2">
          <form
            className="panel"
            onSubmit={(e) => {
              e.preventDefault()
              const fd = new FormData(e.currentTarget)
              const toMember = String(fd.get('memberId') || '')
              if (!transferBlockIds.length) return showToast('Selecione ao menos um bloco.')
              if (!toMember) return showToast('Selecione o membro.')
              setSensitiveError(null)
              setSensitiveOp({ type: 'transferir', toMemberId: toMember, blockIds: [...transferBlockIds] })
            }}
          >
            <div className="panel-head">
              <div>
                <h2>Transferir bloco entre membros</h2>
                <p>Azul = tem números abertos. Vermelho = vendido (não transfere). Selecione um ou vários.</p>
              </div>
            </div>
            <div className="form-grid">
              <label className="full">
                Evento
                <select
                  value={transferEventId || filterEventId || raffles[0]?.id || ''}
                  onChange={(e) => {
                    setTransferEventId(e.target.value)
                    setTransferBlockIds([])
                  }}
                >
                  {raffles.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.eventName}
                    </option>
                  ))}
                </select>
              </label>
              <div className="full">
                <span className="field-label">Blocos já atribuídos</span>
                <div className="transfer-block-list">
                  {blocks
                    .filter((b) => b.raffleId === (transferEventId || filterEventId || raffles[0]?.id) && b.memberId)
                    .sort((a, b) => a.index - b.index)
                    .map((b) => {
                      const st = blockStats(b.id)
                      const soldOut = st.open <= 0
                      const owner = members.find((m) => m.id === b.memberId)?.name || '—'
                      const selected = transferBlockIds.includes(b.id)
                      return (
                        <button
                          key={b.id}
                          type="button"
                          className={`transfer-block ${soldOut ? 'sold-out' : 'has-open'} ${selected ? 'selected' : ''}`}
                          disabled={soldOut}
                          onClick={() => {
                            if (soldOut) {
                              showToast('Esse bloco não pode ser transferido: está vendido (sem números abertos).')
                              return
                            }
                            setTransferBlockIds((prev) =>
                              prev.includes(b.id) ? prev.filter((id) => id !== b.id) : [...prev, b.id],
                            )
                          }}
                        >
                          <strong>{b.label}</strong>
                          <span className="owner-assigned">
                            {b.fromNumber}–{b.toNumber} · {owner}
                          </span>
                          <span>{soldOut ? '\u00a0' : `${st.open} abertos`}</span>
                          {soldOut ? <span className="vendido-stamp">VENDIDO!</span> : null}
                        </button>
                      )
                    })}
                </div>
                {!transferBlockIds.length && <p className="hint">Selecione um ou mais blocos azuis.</p>}
                {transferBlockIds.length > 0 && (
                  <p className="hint">{transferBlockIds.length} bloco(s) selecionado(s).</p>
                )}
              </div>
              <label className="full">
                Novo membro
                <select name="memberId" required defaultValue="">
                  <option value="" disabled>
                    Selecione
                  </option>
                  {members.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="btn-row">
              <button className="btn btn-primary" type="submit" disabled={!transferBlockIds.length}>
                Transferir {transferBlockIds.length > 1 ? `blocos (${transferBlockIds.length})` : 'bloco'}
              </button>
            </div>
          </form>

          <div className="panel">
            <div className="panel-head">
              <div>
                <h2>Últimas movimentações</h2>
                <p>Rastro de atribuições, transferências e liberações.</p>
              </div>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Quando</th>
                    <th>Tipo</th>
                    <th>Bloco</th>
                    <th>De</th>
                    <th>Para</th>
                  </tr>
                </thead>
                <tbody>
                  {blockTransfers.slice(0, 40).map((t) => {
                    const block = blocks.find((b) => b.id === t.blockId)
                    const kindLabel =
                      t.kind === 'assign' ? 'Atribuição' : t.kind === 'transfer' ? 'Transferência' : 'Liberação'
                    const rowClass =
                      t.kind === 'assign' ? 'row-assign' : t.kind === 'transfer' ? 'row-transfer' : ''
                    return (
                      <tr key={t.id} className={rowClass}>
                        <td>{new Date(t.createdAt).toLocaleString('pt-BR')}</td>
                        <td>{kindLabel}</td>
                        <td>{block?.label || '—'}</td>
                        <td>{t.fromMemberId ? members.find((m) => m.id === t.fromMemberId)?.name || '—' : 'livre'}</td>
                        <td>{t.toMemberId ? members.find((m) => m.id === t.toMemberId)?.name || '—' : 'livre'}</td>
                      </tr>
                    )
                  })}
                  {blockTransfers.length === 0 && (
                    <tr>
                      <td colSpan={5}>
                        <p className="empty">Nenhuma movimentação ainda.</p>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      {isAdmin && adminTab === 'eventos' && (
        <section>
          {!openEventId && (
            <>
              <form
                className="panel"
                style={{ marginBottom: '1rem' }}
                onSubmit={(e) => {
                  e.preventDefault()
                  const fd = new FormData(e.currentTarget)
                  const result = addRaffle({
                    eventName: String(fd.get('eventName') || ''),
                    name: String(fd.get('name') || ''),
                    prize: String(fd.get('prize') || ''),
                    ticketPrice: Number(fd.get('ticketPrice')),
                    blockCount: Number(fd.get('blockCount')),
                    numbersPerBlock: Number(fd.get('numbersPerBlock')),
                    startDate: String(fd.get('startDate') || '') || undefined,
                    drawDate: String(fd.get('drawDate') || '') || undefined,
                  })
                  if (!result.ok) return showToast(result.error)
                  e.currentTarget.reset()
                  showToast(`Evento criado com ${result.raffle.blockCount} blocos.`)
                  logAudit(
                    'evento.criar',
                    `${result.raffle.eventName} · ${result.raffle.blockCount} bloco(s) × ${result.raffle.numbersPerBlock} nº · ${brl(result.raffle.ticketPrice)}/nº`,
                    {
                      Evento: result.raffle.eventName,
                      Rifa: result.raffle.name,
                      Premiação: result.raffle.prize,
                      Blocos: `${result.raffle.blockCount} × ${result.raffle.numbersPerBlock} nº`,
                      'Total de números': `${result.raffle.totalNumbers}`,
                      'Valor por número': brl(result.raffle.ticketPrice),
                      'Arrecadação prevista': brl(result.raffle.totalNumbers * result.raffle.ticketPrice),
                      Sorteio: result.raffle.drawDate
                        ? new Date(result.raffle.drawDate).toLocaleDateString('pt-BR')
                        : undefined,
                    },
                  )
                  requestCloudPush()
                }}
              >
                <div className="panel-head">
                  <div>
                    <h2>Novo evento / rifa por blocos</h2>
                    <p>Ex.: 4 blocos × 50 cartelas = 200 números.</p>
                  </div>
                </div>
                <div className="form-grid">
                  <label className="full">
                    Nome do evento
                    <input name="eventName" required placeholder="Ex.: Festa da Turma 2026" />
                  </label>
                  <label className="full">
                    Nome da rifa
                    <input name="name" required />
                  </label>
                  <label>
                    Preço do nº
                    <input name="ticketPrice" type="number" step="0.01" min="0.01" required />
                  </label>
                  <label>
                    Qtd. de blocos
                    <input name="blockCount" type="number" min="1" required defaultValue={4} />
                  </label>
                  <label>
                    Cartelas por bloco
                    <input name="numbersPerBlock" type="number" min="1" required defaultValue={50} />
                  </label>
                  <label>
                    Início das vendas
                    <input name="startDate" type="date" />
                  </label>
                  <label>
                    Data do sorteio
                    <input name="drawDate" type="date" />
                  </label>
                  <label className="full">
                    Prêmios
                    <input name="prize" required placeholder="Ex.: Moto, iPhone, TV" />
                  </label>
                </div>
                <div className="btn-row">
                  <button className="btn btn-primary" type="submit">
                    Criar com blocos
                  </button>
                </div>
              </form>

              <div className="event-grid">
                {raffles.map((r) => {
                  const eventBlocks = blocks.filter((b) => b.raffleId === r.id)
                  const openNums = eventBlocks.reduce((acc, b) => acc + blockStats(b.id).open, 0)
                  return (
                    <button key={r.id} type="button" className="event-card" onClick={() => setOpenEventId(r.id)}>
                      <strong>{r.eventName}</strong>
                      <span className="prize-line">{r.prize}</span>
                      <span className="hint">
                        {brl(r.ticketPrice)} · {r.blockCount || eventBlocks.length} blocos · {r.totalNumbers} números
                      </span>
                      <span className="hint">{openNums} nº ainda abertos</span>
                      <span className="hint">Toque para abrir</span>
                    </button>
                  )
                })}
              </div>
            </>
          )}

          {openEventId &&
            (() => {
              const r = raffles.find((x) => x.id === openEventId)
              if (!r) return null
              const eventBlocks = blocks.filter((b) => b.raffleId === r.id).sort((a, b) => a.index - b.index)
              const openNums = eventBlocks.reduce((acc, b) => acc + blockStats(b.id).open, 0)
              return (
                <section className="panel">
                  <div className="panel-head">
                    <div>
                      <button type="button" className="btn btn-secondary" onClick={() => setOpenEventId(null)}>
                        ← Voltar aos eventos
                      </button>
                    </div>
                    <button
                      type="button"
                      className="btn btn-danger"
                      onClick={() => {
                        setSensitiveError(null)
                        setSensitiveOp({ type: 'removerEvento', raffleId: r.id })
                      }}
                    >
                      Remover evento
                    </button>
                  </div>
                  <header className="event-hero">
                    <p className="event-kicker">{r.name}</p>
                    <h2>{r.eventName}</h2>
                    <p className="event-prize">Premiação: {r.prize}</p>
                    <div className="event-meta">
                      <span>
                        <strong>Valor</strong>
                        {brl(r.ticketPrice)} / número
                      </span>
                      <span>
                        <strong>Blocos</strong>
                        {r.blockCount || eventBlocks.length} × {r.numbersPerBlock || '—'}
                      </span>
                      <span>
                        <strong>Números</strong>
                        {r.totalNumbers} (abertos: {openNums})
                      </span>
                      <span>
                        <strong>Início</strong>
                        {r.startDate ? new Date(r.startDate).toLocaleDateString('pt-BR') : '—'}
                      </span>
                      <span>
                        <strong>Sorteio</strong>
                        {r.drawDate ? new Date(r.drawDate).toLocaleDateString('pt-BR') : '—'}
                      </span>
                    </div>
                  </header>
                  <div className="block-grid">
                    {eventBlocks.map((b) => {
                      const st = blockStats(b.id)
                      const soldOut = st.open <= 0
                      const owner = members.find((m) => m.id === b.memberId)?.name
                      return (
                        <div key={b.id} className={`block-card ${soldOut ? 'sold-out' : 'has-open'}`}>
                          <strong>{b.label}</strong>
                          <span className="hint">
                            nº {b.fromNumber}–{b.toNumber}
                          </span>
                          <span className="block-open">{soldOut ? '\u00a0' : `${st.open} abertos`}</span>
                          <span className={owner ? 'owner-assigned' : 'owner-free'}>{owner || 'livre'}</span>
                          {soldOut ? <span className="vendido-stamp">VENDIDO!</span> : null}
                        </div>
                      )
                    })}
                  </div>
                </section>
              )
            })()}
        </section>
      )}

      {isAdmin && adminTab === 'vendas' && (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Todas as vendas</h2>
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Membro</th>
                  <th>Comprador</th>
                  <th>Números</th>
                  <th>Recebimento</th>
                  <th>Status</th>
                  <th>Comprovante</th>
                </tr>
              </thead>
              <tbody>
                {sales.map((s) => {
                  const rowCharge = pixCharges.find((c) => c.saleId === s.id)
                  const cancel = cancelInfo(s, rowCharge)
                  const pixVencido =
                    !cancel &&
                    s.paymentMethod === 'pix' &&
                    s.status === 'pendente' &&
                    isPixChargeExpired(rowCharge)
                  return (
                  <tr key={s.id} className={s.cancelledAt ? 'sale-cancelled' : undefined}>
                    <td>{members.find((m) => m.id === s.memberId)?.name || '—'}</td>
                    <td>{s.buyerName}</td>
                    <td>{formatNumbers(s.numbers)}</td>
                    <td>
                      {s.paymentMethod === 'dinheiro'
                        ? `Dinheiro (${s.cashDestination === 'loja' ? 'loja' : 'vendedor'})`
                        : `PIX/${s.pixDestination || '—'}`}
                      <div className="hint">
                        {brl(s.paidAmount)}/{brl(s.totalAmount)}
                      </div>
                    </td>
                    <td>
                      {cancel ? (
                        <div className="sale-status-actions">
                          <span className="badge falha">{cancel.label}</span>
                          <InfoPopover
                            label="Ver motivo"
                            title={cancel.label}
                            tone="falha"
                            lines={[
                              cancel.reason,
                              cancel.who ? `Cancelado por: ${cancel.who}` : null,
                              `Em ${new Date(cancel.at).toLocaleString('pt-BR')}`,
                            ]}
                          />
                        </div>
                      ) : pixVencido ? (
                        <div className="sale-status-actions">
                          <span className="badge falha">Pagamento expirado</span>
                          <InfoPopover
                            label="Ver motivo"
                            title="Pagamento expirado"
                            tone="falha"
                            lines={[
                              'O prazo do QR do PIX passou sem o comprador pagar.',
                              'Os números já voltaram a ficar livres.',
                              rowCharge?.expiresAt
                                ? `Venceu em ${new Date(rowCharge.expiresAt).toLocaleString('pt-BR')}`
                                : null,
                            ]}
                          />
                        </div>
                      ) : (
                        <span className={`badge ${s.status}`}>{statusLabel[s.status]}</span>
                      )}
                    </td>
                    <td>
                      {(() => {
                        const charge = rowCharge
                        const proofUrl = proofUrlForSale(s, pixCharges)
                        return (
                          <div className="proof-cell">
                            {s.paymentMethod === 'dinheiro' ? (
                              <>
                                <span>Dinheiro</span>
                                <span className="hint">
                                  {s.cashSettledAt
                                    ? `Prestado em ${new Date(s.cashSettledAt).toLocaleDateString('pt-BR')}`
                                    : s.cashDestination === 'loja'
                                      ? 'Entregue na loja'
                                      : 'Com o vendedor'}
                                </span>
                              </>
                            ) : charge?.txid ? (
                              <>
                                <span>TXID</span>
                                <code className="proof-txid">{charge.txid}</code>
                                <span className="hint">
                                  {cancel
                                    ? cancel.label
                                    : charge.status === 'paid'
                                      ? `Pago${charge.paidAt ? ` em ${new Date(charge.paidAt).toLocaleString('pt-BR')}` : ''}`
                                      : charge.status === 'pending'
                                        ? 'Aguardando Sicoob'
                                        : charge.status === 'expired'
                                          ? 'QR expirado'
                                          : 'Cancelado'}
                                </span>
                              </>
                            ) : (
                              <span className="hint">PIX sem TXID</span>
                            )}
                            {proofUrl ? (
                              <button
                                type="button"
                                className="btn-proof"
                                title="Abrir comprovante"
                                onClick={() => openProofUrl(proofUrl)}
                              >
                                <ProofIcon />
                              </button>
                            ) : null}
                          </div>
                        )
                      })()}
                    </td>
                  </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {isAdmin && adminTab === 'txid' && (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>TXIDs / PIX da loja</h2>
              <p>Cobranças geradas na venda · vinculadas ao membro e ao comprador. Baixa automática via Sicoob.</p>
            </div>
            <button type="button" className="btn btn-secondary" onClick={() => void syncPixChargesFromCloud()}>
              Atualizar
            </button>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Quando</th>
                  <th>Membro</th>
                  <th>Comprador</th>
                  <th>Números</th>
                  <th>TXID</th>
                  <th>Valor</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {pixCharges.length === 0 && (
                  <tr>
                    <td colSpan={7}>
                      <p className="empty">
                        Nenhuma cobrança PIX ainda. Quando o membro gerar o QR, o TXID aparece aqui.
                      </p>
                    </td>
                  </tr>
                )}
                {[...pixCharges]
                  .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
                  .map((c) => {
                    const sale = sales.find((s) => s.id === c.saleId)
                    const member = members.find((m) => m.id === (sale?.memberId || ''))
                    const cancel = cancelInfo(sale, c)
                    const failed =
                      Boolean(cancel) ||
                      c.status === 'expired' ||
                      c.status === 'cancelled' ||
                      sale?.status === 'divergente' ||
                      sale?.status === 'parcial'
                    return (
                      <tr key={c.id} className={failed ? 'txid-falha' : undefined}>
                        <td>{c.createdAt ? new Date(c.createdAt).toLocaleString('pt-BR') : '—'}</td>
                        <td>{member?.name || '—'}</td>
                        <td>
                          {sale?.buyerName || '—'}
                          {sale?.buyerPhone ? <div className="hint">{sale.buyerPhone}</div> : null}
                        </td>
                        <td>{sale ? formatNumbers(sale.numbers) : '—'}</td>
                        <td>
                          <code>{c.txid}</code>
                          {c.provider ? <div className="hint">{c.provider}</div> : null}
                        </td>
                        <td>{brl(c.amount)}</td>
                        <td>
                          <span
                            className={`badge ${failed ? 'falha' : c.status === 'paid' ? 'quitado' : 'pendente'}`}
                          >
                            {cancel
                              ? cancel.label
                              : failed
                                ? 'falha'
                                : c.status === 'paid'
                                  ? 'pago'
                                  : c.status}
                          </span>
                          {cancel ? (
                            <div className="txid-cancel">
                              <InfoPopover
                                label="Ver motivo"
                                title={cancel.label}
                                tone="falha"
                                lines={[
                                  cancel.reason,
                                  cancel.who ? `Cancelado por: ${cancel.who}` : null,
                                  `Em ${new Date(cancel.at).toLocaleString('pt-BR')}`,
                                ]}
                              />
                            </div>
                          ) : sale ? (
                            <div className="hint">venda: {statusLabel[sale.status]}</div>
                          ) : null}
                        </td>
                      </tr>
                    )
                  })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {isAdmin && adminTab === 'amortizacao' && (
        <section className="reports-stack">
          <div className="panel">
            <div className="panel-head">
              <div>
                <h2>Prestação de contas (Dinheiro)</h2>
                <p>Selecione o membro, marque as vendas em aberto e liquide com senha do ADM + PIN do membro.</p>
              </div>
              <div className="baixa-totals">
                <div>
                  <span className="hint">Total em aberto</span>
                  <strong>{brl(baixaOpenTotal)}</strong>
                </div>
                <div>
                  <span className="hint">Valor a quitar</span>
                  <strong>{brl(baixaQuitTotal)}</strong>
                </div>
              </div>
            </div>

            <div className="form-grid report-filters">
              <label>
                Membro
                <select
                  value={baixaMemberId}
                  onChange={(e) => {
                    setBaixaMemberId(e.target.value)
                    setBaixaSelectedIds([])
                  }}
                >
                  <option value="">Selecione o membro</option>
                  {members
                    .filter((m) => m.active)
                    .map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                </select>
              </label>
            </div>

            {!baixaMemberId && <p className="empty">Escolha um membro para ver as pendências em dinheiro.</p>}

            {baixaMemberId && (
              <>
                <label className="baixa-check-all">
                  <input
                    type="checkbox"
                    checked={baixaPendingSales.length > 0 && baixaSelectedIds.length === baixaPendingSales.length}
                    onChange={(e) => {
                      setBaixaSelectedIds(e.target.checked ? baixaPendingSales.map((s) => s.id) : [])
                    }}
                  />
                  Marcar todos
                </label>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th></th>
                        <th>Quando</th>
                        <th>Comprador</th>
                        <th>Números</th>
                        <th>Valor</th>
                        <th>Obs.</th>
                      </tr>
                    </thead>
                    <tbody>
                      {baixaPendingSales.length === 0 && (
                        <tr>
                          <td colSpan={6}>
                            <p className="empty">Nenhuma pendência em dinheiro para este membro.</p>
                          </td>
                        </tr>
                      )}
                      {baixaPendingSales.map((s) => (
                        <tr key={s.id}>
                          <td>
                            <input
                              type="checkbox"
                              checked={baixaSelectedIds.includes(s.id)}
                              onChange={(e) => {
                                setBaixaSelectedIds((prev) =>
                                  e.target.checked ? [...prev, s.id] : prev.filter((id) => id !== s.id),
                                )
                              }}
                            />
                          </td>
                          <td>{new Date(s.createdAt).toLocaleString('pt-BR')}</td>
                          <td>
                            {s.buyerName}
                            {s.buyerPhone ? <div className="hint">{s.buyerPhone}</div> : null}
                          </td>
                          <td>{formatNumbers(s.numbers)}</td>
                          <td>{brl(s.totalAmount)}</td>
                          <td>{s.notes || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="btn-row">
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={baixaQuitTotal <= 0 || settlingBaixa}
                    onClick={() => {
                      if (baixaQuitTotal <= 0 || settlingBaixa) return
                      setBaixaConfirmError(null)
                      setBaixaConfirmOpen(true)
                    }}
                  >
                    {settlingBaixa ? 'Liquidando…' : `Liquidar ${brl(baixaQuitTotal)}`}
                  </button>
                </div>
              </>
            )}
          </div>
        </section>
      )}

      {isAdmin && adminTab === 'relatorios' && (
        <section className="reports-stack">
          <div className="panel">
            <div className="panel-head">
              <div>
                <h2>Relatórios por membro</h2>
                <p>Um membro por vez — financeiro, vendas, blocos e baixas sem misturar a equipe.</p>
              </div>
            </div>
            <div className="form-grid report-filters">
              <label>
                Evento
                <select
                  value={reportEventId}
                  onChange={(e) => {
                    setReportEventId(e.target.value)
                  }}
                >
                  <option value="">Todos os eventos</option>
                  {raffles.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.eventName || r.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Membro
                <select
                  value={reportMemberId}
                  onChange={(e) => {
                    setReportMemberId(e.target.value)
                    setReportDetail('resumo')
                  }}
                >
                  <option value="">Ver ranking da equipe</option>
                  {reports.map((r) => (
                    <option key={r.member.id} value={r.member.id}>
                      {r.member.name}
                      {r.dueTotal > 0 ? ` · a prestar ${brl(r.dueTotal)}` : ''}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="hero-metrics report-metrics">
              <div className="metric-group metric-group--estoque">
                <article className="metric">
                  <span>Esperado (a vender)</span>
                  <strong>{brl(reportGlobals.esperado)}</strong>
                  <em>
                    {reportGlobals.aVenderQtd} nº a vender ·{' '}
                    {pct(reportGlobals.aVenderQtd, reportGlobals.totalNumeros)} de{' '}
                    {reportGlobals.totalNumeros} nº
                  </em>
                </article>
                <article className="metric">
                  <span>Vendido</span>
                  <strong>{brl(reportGlobals.vendidoValor)}</strong>
                  <em>
                    {reportGlobals.vendidosQtd} nº vendidos ·{' '}
                    {pct(reportGlobals.vendidosQtd, reportGlobals.totalNumeros)} de{' '}
                    {reportGlobals.totalNumeros} nº
                  </em>
                </article>
              </div>
              <div className="metric-group metric-group--caixa">
                <article className="metric">
                  <span>Recebido</span>
                  <strong>{brl(reportGlobals.recebido)}</strong>
                  <em>PIX na loja + dinheiro já prestado</em>
                </article>
                <article className="metric">
                  <span>A receber — a prestar contas</span>
                  <strong>{brl(reportGlobals.aPrestar)}</strong>
                  <em>dinheiro ainda com os vendedores</em>
                </article>
              </div>
              <div className="metric-group metric-group--meio">
                <article className="metric">
                  <span>Recebido em PIX</span>
                  <strong>{brl(reportGlobals.pixRecebido)}</strong>
                  <em>
                    {reportGlobals.pixNumeros} nº em PIX ·{' '}
                    {pct(reportGlobals.pixNumeros, reportGlobals.totalNumeros)} de{' '}
                    {reportGlobals.totalNumeros} nº
                  </em>
                </article>
                <article className="metric">
                  <span>Recebido em dinheiro</span>
                  <strong>{brl(reportGlobals.dinheiroRecebido)}</strong>
                  <em>
                    {reportGlobals.dinheiroNumeros} nº já prestados ·{' '}
                    {pct(reportGlobals.dinheiroNumeros, reportGlobals.totalNumeros)} de{' '}
                    {reportGlobals.totalNumeros} nº
                  </em>
                </article>
              </div>
              <div className="metric-group metric-group--canal">
                <article className="metric">
                  <span>Números vendidos em contingência</span>
                  <strong>{reportGlobals.contingenciaNumeros}</strong>
                  <em>
                    {reportGlobals.contingenciaNumeros} nº vendidos sem rede ·{' '}
                    {pct(reportGlobals.contingenciaNumeros, reportGlobals.totalNumeros)} de{' '}
                    {reportGlobals.totalNumeros} nº
                  </em>
                </article>
                <article className="metric">
                  <span>Números vendidos online</span>
                  <strong>{reportGlobals.onlineNumeros}</strong>
                  <em>
                    {reportGlobals.onlineNumeros} nº com nuvem ·{' '}
                    {pct(reportGlobals.onlineNumeros, reportGlobals.totalNumeros)} de{' '}
                    {reportGlobals.totalNumeros} nº
                  </em>
                </article>
              </div>
              <div className="metric-group metric-group--cancela">
                <article className="metric">
                  <span>Cancelados por membro</span>
                  <strong>{reportGlobals.cancMembro.qtd}</strong>
                  <em>
                    {reportGlobals.cancMembro.numeros} nº liberados ·{' '}
                    {brl(reportGlobals.cancMembro.valor)}
                  </em>
                </article>
                <article className="metric">
                  <span>Cancelados por tempo</span>
                  <strong>{reportGlobals.cancTempo.qtd}</strong>
                  <em>
                    {reportGlobals.cancTempo.numeros} nº liberados · {brl(reportGlobals.cancTempo.valor)}
                  </em>
                </article>
              </div>
            </div>
          </div>

          {!selectedReport && (
            <div className="panel">
              <div className="panel-head">
                <div>
                  <h2>Ranking da equipe</h2>
                  <p>Do maior para o menor vendedor. Toque no membro para abrir o dossiê completo.</p>
                </div>
              </div>
              <div className="member-report-list">
                {reports.map((r, i) => {
                  const bs = memberBlockStats(r.member.id, reportEventId || undefined)
                  return (
                    <div key={r.member.id} className="member-report-row">
                      <button
                        type="button"
                        className="member-report-open"
                        onClick={() => {
                          setReportMemberId(r.member.id)
                          setReportDetail('resumo')
                        }}
                      >
                        <div className="member-report-main">
                          <strong>
                            <span className={`rank-badge ${i === 0 ? 'rank-top' : ''}`}>{i + 1}º</span>
                            {r.member.name}
                          </strong>
                          <span className="hint">
                            {r.saleCount} vendas · {r.soldCount} nº · {bs.blocks} blocos
                            {bs.openNumbers > 0 ? ` · ${bs.openNumbers} abertos` : ''}
                          </span>
                          {r.cancMembro + r.cancTempo > 0 ? (
                            <span className="hint cancel-tally">
                              {r.cancMembro > 0 ? `${r.cancMembro} cancelada(s) pelo membro` : ''}
                              {r.cancMembro > 0 && r.cancTempo > 0 ? ' · ' : ''}
                              {r.cancTempo > 0 ? `${r.cancTempo} expirada(s) por tempo` : ''}
                            </span>
                          ) : null}
                        </div>
                        <div className="member-report-kpis">
                          <span>
                            Esperado
                            <strong>{brl(r.expected)}</strong>
                          </span>
                          <span>
                            Recebido
                            <strong>{brl(r.received)}</strong>
                          </span>
                          <span className={r.dueTotal > 0 ? 'due' : 'ok'}>
                            A prestar
                            <strong>{brl(r.dueTotal)}</strong>
                          </span>
                        </div>
                      </button>
                      <button
                        type="button"
                        className="btn btn-mini btn-settle"
                        disabled={r.dueTotal <= 0}
                        title={
                          r.dueTotal > 0
                            ? `Baixar ${brl(r.dueTotal)} em dinheiro com ${r.member.name}`
                            : 'Sem dinheiro pendente com este membro'
                        }
                        onClick={() => {
                          setBaixaMemberId(r.member.id)
                          setBaixaSelectedIds([])
                          setAdminTab('amortizacao')
                        }}
                      >
                        Prestar contas
                      </button>
                    </div>
                  )
                })}
                {reports.length === 0 && <p className="empty">Nenhum membro ativo.</p>}
              </div>
            </div>
          )}

          {selectedReport && (
            <div className="panel member-dossier">
              <div className="panel-head">
                <div>
                  <button type="button" className="linkish" onClick={() => setReportMemberId('')}>
                    ← Voltar à equipe
                  </button>
                  <h2>{selectedReport.member.name}</h2>
                  <p>
                    Dossiê individual
                    {reportEventId
                      ? ` · ${raffles.find((r) => r.id === reportEventId)?.eventName || 'evento'}`
                      : ' · todos os eventos'}
                    .
                  </p>
                </div>
                <div className="btn-row wrap">
                  <div className="baixa-totals">
                    <div>
                      <span className="hint">Total recebido (prestações)</span>
                      <strong>
                        {brl(
                          selectedReport.settlements.reduce((a, x) => a + x.amount, 0) +
                            selectedReport.mSales
                              .filter((s) => s.paymentMethod === 'pix' && s.status === 'quitado')
                              .reduce((a, s) => a + s.paidAmount, 0),
                        )}
                      </strong>
                    </div>
                    <div>
                      <span className="hint">A prestar (dinheiro)</span>
                      <strong className={selectedReport.cashOpen > 0 ? 'warn-text' : ''}>
                        {brl(selectedReport.cashOpen)}
                      </strong>
                    </div>
                  </div>
                </div>
              </div>

              <div className="report-tabs">
                {(
                  [
                    ['resumo', 'Resumo'],
                    ['vendas', 'Vendas'],
                    ['blocos', 'Blocos'],
                    ['baixas', 'Baixas / prestações'],
                    ['movimentos', 'Movimentos de bloco'],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    className={reportDetail === id ? 'active' : ''}
                    onClick={() => setReportDetail(id)}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {reportDetail === 'resumo' && (
                <div className="dossier-body">
                  <div className="hero-metrics report-metrics">
                    <article className="metric">
                      <span>Esperado</span>
                      <strong>{brl(selectedReport.unsoldValor)}</strong>
                      <em>
                        {selectedReport.unsoldNumbers} nº ainda não vendidos ·{' '}
                        {pct(selectedReport.unsoldNumbers, reportGlobals.aVenderQtd)} do geral a vender
                      </em>
                    </article>
                    <article className="metric">
                      <span>Recebido</span>
                      <strong>{brl(selectedReport.dinheiroNaLoja)}</strong>
                      <em>
                        PIX + contas já prestadas ·{' '}
                        {pct(selectedReport.dinheiroNaLoja, reportGlobals.recebido)} do recebido geral
                      </em>
                    </article>
                    <article className="metric">
                      <span>Em aberto</span>
                      <strong>{brl(selectedReport.cashOpen)}</strong>
                      <em>
                        dinheiro com o membro · {pct(selectedReport.cashOpen, reportGlobals.aPrestar)} do a
                        prestar geral
                      </em>
                    </article>
                    <article className="metric">
                      <span>Ticket médio</span>
                      <strong>{brl(selectedReport.ticketMedio)}</strong>
                      <em>
                        {selectedReport.saleCount
                          ? `${selectedReport.saleCount} venda(s) deste membro`
                          : 'sem vendas'}
                      </em>
                    </article>
                  </div>

                  <div className="breakdown-grid">
                    <article>
                      <h3>Origem do dinheiro</h3>
                      <ul className="breakdown-list">
                        <li>
                          <span>Dinheiro já na loja</span>
                          <strong>{brl(selectedReport.dinheiroNaLoja)}</strong>
                        </li>
                        <li>
                          <span>Dinheiro ainda com o vendedor</span>
                          <strong>{brl(selectedReport.cashOpen)}</strong>
                        </li>
                      </ul>
                    </article>
                    <article>
                      <h3>Vendas</h3>
                      <ul className="breakdown-list">
                        <li>
                          <span>Venda PIX</span>
                          <strong>{brl(selectedReport.pixSalesAmount)}</strong>
                        </li>
                        <li>
                          <span>Vendas em dinheiro</span>
                          <strong>{brl(selectedReport.cashSalesAmount)}</strong>
                        </li>
                        <li>
                          <span>Valor do ticket</span>
                          <strong>{brl(selectedReport.ticketPrice)}</strong>
                        </li>
                        <li>
                          <span>Total vendas</span>
                          <strong>{brl(selectedReport.expected)}</strong>
                        </li>
                      </ul>
                    </article>
                    <article>
                      <h3>Status das vendas</h3>
                      <ul className="breakdown-list">
                        <li>
                          <span>Quitado</span>
                          <strong>{selectedReport.byStatus.quitado}</strong>
                        </li>
                        <li>
                          <span>Pendente (dinheiro a prestar)</span>
                          <strong>{selectedReport.byStatus.pendente}</strong>
                        </li>
                        <li>
                          <span>Parcial</span>
                          <strong>{selectedReport.byStatus.parcial}</strong>
                        </li>
                        <li className={selectedReport.byStatus.falha || selectedReport.byStatus.divergente ? 'warn' : ''}>
                          <span>Divergente / falha</span>
                          <strong>
                            {(selectedReport.byStatus.falha || 0) + (selectedReport.byStatus.divergente || 0)}
                          </strong>
                        </li>
                      </ul>
                    </article>
                  </div>

                  {(() => {
                    const bs = memberBlockStats(selectedReport.member.id, reportEventId || undefined)
                    return (
                      <div className="hint dossier-hint">
                        Blocos: {bs.blocks} · com aberto {bs.openBlocks} · esgotados {bs.soldOutBlocks} · nº
                        abertos {bs.openNumbers} · nº vendidos nos blocos {bs.soldNumbers}
                        {reportEventId
                          ? ' · Prestações são globais; o filtro de evento afeta vendas e blocos.'
                          : ''}
                      </div>
                    )
                  })()}
                </div>
              )}

              {reportDetail === 'vendas' && (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Data</th>
                        <th>Evento</th>
                        <th>Comprador</th>
                        <th>Números</th>
                        <th>Valor</th>
                        <th>Forma</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...selectedReport.mSales]
                        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                        .map((s) => {
                          const raffle = raffles.find((r) => r.id === s.raffleId)
                          const ui = saleUiStatus(s, pixCharges)
                          return (
                            <tr key={s.id}>
                              <td>{new Date(s.createdAt).toLocaleString('pt-BR')}</td>
                              <td>{raffle?.eventName || raffle?.name || '—'}</td>
                              <td>
                                {s.buyerName}
                                {s.buyerPhone ? <div className="hint">{s.buyerPhone}</div> : null}
                              </td>
                              <td>{formatNumbers(s.numbers)}</td>
                              <td>{brl(s.totalAmount)}</td>
                              <td>{s.paymentMethod === 'dinheiro' ? 'Dinheiro' : 'PIX'}</td>
                              <td>
                                <span className={`badge ${ui === 'falha' ? 'falha' : ui}`}>
                                  {ui === 'falha' ? 'Falha' : ui === 'quitado' ? 'Quitado' : 'Pendente'}
                                </span>
                              </td>
                            </tr>
                          )
                        })}
                      {selectedReport.mSales.length === 0 && (
                        <tr>
                          <td colSpan={7}>
                            <p className="empty">Nenhuma venda deste membro no filtro.</p>
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}

              {reportDetail === 'blocos' && (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Evento</th>
                        <th>Bloco</th>
                        <th>Faixa</th>
                        <th>Total</th>
                        <th>Vendidos</th>
                        <th>Abertos</th>
                      </tr>
                    </thead>
                    <tbody>
                      {blocks
                        .filter(
                          (b) =>
                            b.memberId === selectedReport.member.id &&
                            (!reportEventId || b.raffleId === reportEventId),
                        )
                        .sort((a, b) => a.index - b.index)
                        .map((b) => {
                          const st = blockStats(b.id)
                          const raffle = raffles.find((r) => r.id === b.raffleId)
                          const soldOut = st.open <= 0
                          const halfSold = !soldOut && st.total > 0 && st.sold >= st.total / 2
                          return (
                            <tr
                              key={b.id}
                              className={soldOut ? 'row-sold-out' : halfSold ? 'row-half-sold' : ''}
                            >
                              <td>{raffle?.eventName || raffle?.name || '—'}</td>
                              <td>{b.label}</td>
                              <td>
                                {b.fromNumber}–{b.toNumber}
                              </td>
                              <td>{st.total}</td>
                              <td>{st.sold}</td>
                              <td>{st.open}</td>
                            </tr>
                          )
                        })}
                      {blocks.filter(
                        (b) =>
                          b.memberId === selectedReport.member.id &&
                          (!reportEventId || b.raffleId === reportEventId),
                      ).length === 0 && (
                        <tr>
                          <td colSpan={6}>
                            <p className="empty">Nenhum bloco com este membro.</p>
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}

              {reportDetail === 'baixas' && (
                <div>
                  {(() => {
                    const pixPaidRows = selectedReport.mSales
                      .filter((s) => s.paymentMethod === 'pix' && saleUiStatus(s, pixCharges) === 'quitado')
                      .map((s) => {
                        const charge = pixCharges.find((c) => c.saleId === s.id && c.status === 'paid')
                        return {
                          id: `pix-${s.id}`,
                          when: charge?.paidAt || s.createdAt,
                          tipo: 'PIX',
                          buyer: s.buyerName,
                          numbers: formatNumbers(s.numbers),
                          amount: s.paidAmount || s.totalAmount,
                          detail: charge?.txid || '—',
                        }
                      })
                    const cashRows = selectedReport.settlements
                      .filter((x) => x.kind === 'dinheiro')
                      .map((x) => {
                        const linked = (x.saleIds || [])
                          .map((id) => sales.find((s) => s.id === id))
                          .filter((s): s is (typeof sales)[number] => Boolean(s))
                        const linkedNumbers = linked.flatMap((s) => s.numbers).sort((a, b) => a - b)
                        return {
                          id: x.id,
                          when: x.createdAt,
                          tipo: 'Dinheiro',
                          buyer: linked.length
                            ? linked.map((s) => s.buyerName).join(', ')
                            : 'Prestação avulsa',
                          numbers: linkedNumbers.length ? formatNumbers(linkedNumbers) : '—',
                          amount: x.amount,
                          detail: x.note || '—',
                        }
                      })
                    const rows = [...pixPaidRows, ...cashRows].sort((a, b) =>
                      String(b.when).localeCompare(String(a.when)),
                    )
                    const totalRecv = rows.reduce((a, r) => a + r.amount, 0)
                    return (
                      <>
                        <p className="hint">
                          Total recebido neste dossiê: <strong>{brl(totalRecv)}</strong>
                        </p>
                        <div className="table-wrap">
                          <table>
                            <thead>
                              <tr>
                                <th>Quando</th>
                                <th>Tipo</th>
                                <th>Comprador</th>
                                <th>Números</th>
                                <th>Valor</th>
                                <th>Detalhe</th>
                              </tr>
                            </thead>
                            <tbody>
                              {rows.length === 0 && (
                                <tr>
                                  <td colSpan={6}>
                                    <p className="empty">Nenhuma baixa ainda (PIX pago ou dinheiro prestado).</p>
                                  </td>
                                </tr>
                              )}
                              {rows.map((r) => (
                                <tr key={r.id}>
                                  <td>{new Date(r.when).toLocaleString('pt-BR')}</td>
                                  <td>{r.tipo}</td>
                                  <td>{r.buyer}</td>
                                  <td>{r.numbers}</td>
                                  <td>{brl(r.amount)}</td>
                                  <td>
                                    {r.tipo === 'PIX' ? <code>{r.detail}</code> : r.detail}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </>
                    )
                  })()}
                </div>
              )}

              {reportDetail === 'movimentos' && (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Quando</th>
                        <th>Tipo</th>
                        <th>Evento</th>
                        <th>Bloco</th>
                        <th>De</th>
                        <th>Para</th>
                        <th>Obs.</th>
                      </tr>
                    </thead>
                    <tbody>
                      {blockTransfers
                        .filter(
                          (t) =>
                            t.fromMemberId === selectedReport.member.id ||
                            t.toMemberId === selectedReport.member.id,
                        )
                        .filter((t) => !reportEventId || t.raffleId === reportEventId)
                        .map((t) => {
                          const block = blocks.find((b) => b.id === t.blockId)
                          const raffle = raffles.find((r) => r.id === t.raffleId)
                          const kindLabel =
                            t.kind === 'assign'
                              ? 'Atribuição'
                              : t.kind === 'transfer'
                                ? 'Transferência'
                                : 'Liberação'
                          return (
                            <tr key={t.id} className={t.kind === 'transfer' ? 'row-transfer' : ''}>
                              <td>{new Date(t.createdAt).toLocaleString('pt-BR')}</td>
                              <td>{kindLabel}</td>
                              <td>{raffle?.eventName || '—'}</td>
                              <td>
                                {block?.label || '—'}
                                {block ? ` (${block.fromNumber}–${block.toNumber})` : ''}
                              </td>
                              <td>
                                {t.fromMemberId
                                  ? members.find((m) => m.id === t.fromMemberId)?.name || '—'
                                  : 'livre'}
                              </td>
                              <td>
                                {t.toMemberId
                                  ? members.find((m) => m.id === t.toMemberId)?.name || '—'
                                  : 'livre'}
                              </td>
                              <td>{t.note || '—'}</td>
                            </tr>
                          )
                        })}
                      {blockTransfers.filter(
                        (t) =>
                          (t.fromMemberId === selectedReport.member.id ||
                            t.toMemberId === selectedReport.member.id) &&
                          (!reportEventId || t.raffleId === reportEventId),
                      ).length === 0 && (
                        <tr>
                          <td colSpan={7}>
                            <p className="empty">Nenhum movimento de bloco deste membro.</p>
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {isAdmin && adminTab === 'auditoria' && (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Auditoria — rastro de ações</h2>
              <p>
                Registro de tudo que a equipe faz no sistema. <strong>Não pode ser apagado</strong>, nem pelo
                botão Limpar do painel.
              </p>
            </div>
            <div className="btn-row" style={{ marginTop: 0 }}>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={!(auditLog || []).length}
                onClick={() => {
                  downloadCsv(`rifapix-auditoria-${new Date().toISOString().slice(0, 10)}.csv`, [
                    ['Quando', 'Quem', 'Ação', 'Código', 'Detalhe', 'Detalhes'],
                    ...(auditLog || []).map((a) => [
                      new Date(a.at).toLocaleString('pt-BR'),
                      a.actorName,
                      auditActionLabel[a.action] || a.action,
                      a.action,
                      a.detail || '',
                      a.meta || a.ref
                        ? auditPopoverLines(a, liveAuditSituacao(a, sales, pixCharges)).join(' | ')
                        : '',
                    ]),
                  ])
                  showToast('CSV da auditoria exportado.')
                }}
              >
                Exportar CSV
              </button>
            </div>
          </div>

          <div className="form-grid report-filters">
            <label className="full">
              Buscar (quem, ação ou detalhe)
              <input
                value={auditQuery}
                onChange={(e) => setAuditQuery(e.target.value)}
                placeholder="Ex.: Heitor, bloco, limpar…"
              />
            </label>
          </div>

          {(() => {
            const q = auditQuery.trim().toLowerCase()
            const rows = (auditLog || []).filter((a) => {
              if (!q) return true
              const label = auditActionLabel[a.action] || a.action
              return [a.actorName, a.action, label, a.detail || '']
                .join(' ')
                .toLowerCase()
                .includes(q)
            })
            return (
              <>
                <p className="hint">
                  {rows.length} de {(auditLog || []).length} registro(s).
                </p>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Quando</th>
                        <th>Quem</th>
                        <th>Ação</th>
                        <th>Detalhe</th>
                        <th>
                          Detalhes
                          <div className="th-hint">passe o mouse / toque</div>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.length === 0 && (
                        <tr>
                          <td colSpan={5}>
                            <p className="empty">
                              {(auditLog || []).length
                                ? 'Nenhum registro para esta busca.'
                                : 'Nenhuma ação registrada ainda.'}
                            </p>
                          </td>
                        </tr>
                      )}
                      {rows.map((a) => (
                        <tr key={a.id}>
                          <td>{new Date(a.at).toLocaleString('pt-BR')}</td>
                          <td>{a.actorName}</td>
                          <td>
                            {auditActionLabel[a.action] || a.action}
                            <div className="hint">
                              <code>{a.action}</code>
                            </div>
                          </td>
                          <td>{a.detail || '—'}</td>
                          <td>
                            <InfoPopover
                              label="Ver detalhes"
                              title={auditActionLabel[a.action] || a.action}
                              lines={[
                                ...auditPopoverLines(a, liveAuditSituacao(a, sales, pixCharges)),
                                `Quem: ${a.actorName}`,
                                `Quando: ${new Date(a.at).toLocaleString('pt-BR')}`,
                              ]}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )
          })()}
        </section>
      )}

      {sensitiveOp && (
        <AdminConfirmModal
          title={
            sensitiveOp.type === 'liberar'
              ? 'Liberar bloco'
              : sensitiveOp.type === 'removerMembro'
                ? 'Remover membro'
                : sensitiveOp.type === 'removerEvento'
                  ? 'Remover evento'
                  : sensitiveOp.type === 'transferir'
                    ? 'Transferir bloco'
                    : 'Atribuir bloco'
          }
          description={
            sensitiveOp.type === 'liberar'
              ? 'Só o ADM confirma com a senha. O bloco volta a ficar livre e o rastro fica na Auditoria.'
              : sensitiveOp.type === 'removerMembro'
                ? 'Só o ADM pode remover membro. Blocos já vendidos continuam travados.'
                : sensitiveOp.type === 'removerEvento'
                  ? 'Remove o evento e os blocos dele. Só o ADM confirma com a senha.'
                  : sensitiveOp.type === 'transferir'
                    ? 'Transfere o(s) bloco(s) entre membros. Só o ADM confirma com a senha.'
                    : 'Atribui o(s) bloco(s) livre(s) ao membro. Só o ADM confirma com a senha.'
          }
          confirmLabel="Confirmar com senha do ADM"
          adminHint={adminCredentialHint()}
          busy={sensitiveBusy}
          error={sensitiveError}
          danger={sensitiveOp.type === 'removerMembro' || sensitiveOp.type === 'removerEvento'}
          onCancel={closeSensitiveOp}
          onConfirm={(pwd) => void confirmSensitiveOp(pwd)}
        />
      )}

      {wipeOpen && (
        <AdminConfirmModal
          title="Limpar todos os dados"
          description="Apaga eventos, blocos, membros, vendas e cobranças PIX deste sistema."
          warning={`Isso remove ${raffles.length} evento(s), ${members.length} membro(s) e ${sales.length} venda(s). Não tem como desfazer. O rastro de ações é preservado na aba Auditoria.`}
          confirmLabel="Limpar tudo"
          adminHint={adminCredentialHint()}
          busy={wipeBusy}
          error={wipeError}
          danger
          onCancel={() => {
            setWipeOpen(false)
            setWipeError(null)
          }}
          onConfirm={(pwd) => void confirmWipeAll(pwd)}
        />
      )}

      {pixModal && (
        <PixChargeModal
          buyerName={pixModal.buyerName}
          amount={pixModal.amount}
          copyPaste={pixModal.copyPaste}
          txid={pixModal.txid}
          isDemo={pixModal.isDemo}
          checking={checkingPix}
          paid={pixPaid}
          expiresAt={pixModal.expiresAt}
          reopened={pixModal.reopened}
          onCancel={() => {
            if (!pixModal.saleId) {
              setPixModal(null)
              setPixPaid(false)
              return
            }
            askCancelReason(pixModal.saleId, true)
          }}
          onClosePaid={finishPaidPixSale}
          onNewSale={isAdmin ? undefined : keepPixAndStartNewSale}
        />
      )}
      {editMemberId && (() => {
        const m = members.find((x) => x.id === editMemberId)
        if (!m) return null
        return (
          <MemberEditModal
            member={m}
            error={editMemberError}
            onCancel={() => {
              setEditMemberId(null)
              setEditMemberError(null)
            }}
            onSave={(patch) => {
              const nameTaken = members.some(
                (x) => x.id !== m.id && x.name.trim().toLowerCase() === patch.name.toLowerCase(),
              )
              if (nameTaken) return setEditMemberError('Já existe outro membro com esse nome.')
              const mudou = [
                patch.name !== m.name ? `nome: ${m.name} → ${patch.name}` : null,
                (patch.phone || '') !== (m.phone || '') ? 'WhatsApp alterado' : null,
                patch.pin !== m.pin ? 'PIN alterado' : null,
              ].filter(Boolean)
              updateMember(m.id, patch)
              logAudit('membro.editar', `${patch.name} · ${mudou.join(', ')}`, {
                Membro: patch.name,
                'Nome anterior': patch.name !== m.name ? m.name : undefined,
                WhatsApp: patch.phone || 'sem WhatsApp',
                PIN: patch.pin !== m.pin ? 'Trocado (não é gravado no log)' : 'Sem mudança',
                Alterações: mudou.join(', '),
              })
              setEditMemberId(null)
              setEditMemberError(null)
              requestCloudPush()
              showToast(`Membro ${patch.name} atualizado.`)
            }}
          />
        )
      })()}
      {cancelAsk && (() => {
        const sale = sales.find((s) => s.id === cancelAsk.saleId)
        if (!sale) return null
        return (
          <CancelReasonModal
            buyerName={sale.buyerName}
            numbers={formatNumbers(sale.numbers)}
            amount={brl(sale.totalAmount)}
            busy={cancelBusy}
            onCancel={() => setCancelAsk(null)}
            onConfirm={(reason) => void confirmCancelPix(reason)}
          />
        )
      })()}
      {baixaConfirmOpen && (
        <SettlementConfirmModal
          memberName={members.find((m) => m.id === baixaMemberId)?.name || 'membro'}
          lines={baixaPendingSales
            .filter((s) => baixaSelectedIds.includes(s.id))
            .map((s) => ({
              id: s.id,
              buyerName: s.buyerName,
              numbers: formatNumbers(s.numbers),
              amount: s.totalAmount,
            }))}
          total={baixaQuitTotal}
          adminHint={adminCredentialHint()}
          busy={settlingBaixa}
          error={baixaConfirmError}
          onCancel={() => {
            setBaixaConfirmOpen(false)
            setBaixaConfirmError(null)
          }}
          onConfirm={(pwd, pin) => void confirmCashSettlement(pwd, pin)}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
      <footer className="app-motto">
        <p>
          <strong>
            <em>“{todaySalesQuote()}”</em>
          </strong>
          <span className="bora"> BORA PRA CIMA!!!</span>
        </p>
      </footer>
      <TeamChat />
    </div>
  )
}
