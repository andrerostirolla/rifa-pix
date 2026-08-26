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
import { adminCredentialHint, verifyAdminCredential } from './lib/adminGuard'
import { formatErr } from './lib/errors'
import { brl, formatNumbers, isPixChargeExpired, useStore } from './store'
import { TeamChat } from './TeamChat'
import { InstallAppButton } from './InstallAppButton'
import type { CashDestination, PaymentMethod, PaymentStatus, PixDestination } from './types'

type AdminTab = 'painel' | 'equipe' | 'transferencias' | 'eventos' | 'vendas' | 'txid' | 'amortizacao' | 'relatorios'
type MemberTab = 'blocos' | 'vendas'

const statusLabel: Record<PaymentStatus, string> = {
  pendente: 'Pendente',
  parcial: 'Parcial',
  quitado: 'Quitado',
  divergente: 'Divergente',
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

  /** Vendas que valem dinheiro — canceladas ficam só no histórico da lista. */
  const activeSales = useMemo(() => sales.filter((s) => !s.cancelledAt), [sales])

  const suggestions = useMemo(() => autoMatchSuggestions(), [sales, pixPayments, pixCharges, amortizations, autoMatchSuggestions])

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
        const pixVendedorOpen = Math.max(0, Math.round((pixVendedor - settledPix) * 100) / 100)
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
          dueTotal: cashOpen,
        }
      })
      .sort((a, b) => b.dueTotal - a.dueTotal || b.expected - a.expected || a.member.name.localeCompare(b.member.name))
  }, [members, activeSales, memberSettlements, reportEventId, pixCharges, raffles])

  const totals = useMemo(() => {
    return reports.reduce(
      (acc, r) => ({
        expected: acc.expected + r.expected,
        received: acc.received + r.received,
        cashLoja: acc.cashLoja + r.cashLoja,
        cashVendedorOpen: acc.cashVendedorOpen + r.cashOpen,
        pixEntidade: acc.pixEntidade + r.pixEntidade,
        pixVendedorOpen: acc.pixVendedorOpen + r.pixVendedorOpen,
        soldCount: acc.soldCount + r.soldCount,
        saleCount: acc.saleCount + r.saleCount,
        dueTotal: acc.dueTotal + r.dueTotal,
      }),
      {
        expected: 0,
        received: 0,
        cashLoja: 0,
        cashVendedorOpen: 0,
        pixEntidade: 0,
        pixVendedorOpen: 0,
        soldCount: 0,
        saleCount: 0,
        dueTotal: 0,
      },
    )
  }, [reports])

  const selectedReport = useMemo(
    () => reports.find((r) => r.member.id === reportMemberId) || null,
    [reports, reportMemberId],
  )

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

      if (memberCash) {
        if (offlineContingency) {
          showToast('Contingência: venda em dinheiro salva neste celular. Sobe pra nuvem quando a rede voltar.')
          logAudit('venda.contingencia', `${buyerName} · ${brl(totalAmount)}`)
        } else {
          showToast('Venda em dinheiro registrada. Ficou com você — preste contas à entidade.')
          logAudit('venda.dinheiro', `${buyerName} · ${brl(totalAmount)}`)
        }
      } else {
        showToast(proofPath ? 'Venda registrada (comprovante na nuvem).' : 'Venda registrada.')
        logAudit('venda.registrar', `${buyerName} · ${brl(totalAmount)}`)
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

  const cancelPendingPixSale = async () => {
    const saleId = pixModal?.saleId
    setPixModal(null)
    setPixPaid(false)
    if (!saleId) return
    const result = cancelPixSale(saleId, 'membro')
    if (!result.ok) return showToast(result.error)
    clearSaleForm()
    logAudit('venda.pix_cancelada', `${formatNumbers(result.numbers)} liberado(s)`)
    try {
      await flushWorkspaceToCloud(useStore.getState().exportSnapshot())
    } catch {
      /* sobe no próximo sync */
    }
    showToast(`PIX cancelado. Números ${formatNumbers(result.numbers)} liberados.`)
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

  const cancelPixFromList = async (saleId: string) => {
    const sale = sales.find((s) => s.id === saleId)
    if (!sale) return
    if (!askProceed(`Cancelar o PIX de ${sale.buyerName}? Os números voltam a ficar livres.`)) return
    const result = cancelPixSale(saleId, 'membro')
    if (!result.ok) return showToast(result.error)
    if (pixModal?.saleId === saleId) {
      setPixModal(null)
      setPixPaid(false)
    }
    logAudit('venda.pix_cancelada', `${sale.buyerName} · ${formatNumbers(result.numbers)}`)
    try {
      await flushWorkspaceToCloud(useStore.getState().exportSnapshot())
    } catch {
      /* sobe no próximo sync */
    }
    showToast(`PIX cancelado. Números ${formatNumbers(result.numbers)} liberados.`)
  }

  const finishPaidPixSale = () => {
    const buyer = pixModal?.buyerName
    const amount = pixModal?.amount
    setPixModal(null)
    setPixPaid(false)
    setSelectedNumbers([])
    setPaymentMethod('dinheiro')
    setProofDataUrl('')
    if (buyer && amount != null) {
      showToast(`Venda PIX para ${buyer} no valor ${brl(amount)} recebida com sucesso.`)
      logAudit('venda.pix', `${buyer} · ${brl(amount)}`)
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
      logAudit('dinheiro.liquidar', `${member.name} · ${brl(result.amount)}`)
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
          logAudit('venda.pix_pago_apos_cancelar', txid)
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

  // QR vencido: venda vira "Cancelada" (fica no histórico riscada) e os números voltam
  useEffect(() => {
    if (isAdmin) return
    const tick = () => {
      const expired = expireStalePixCharges()
      if (!expired.length) return
      const freed = useStore
        .getState()
        .sales.filter((s) => expired.includes(s.id))
        .flatMap((s) => s.numbers)
        .sort((a, b) => a - b)
      setPixModal((prev) => (prev?.saleId && expired.includes(prev.saleId) ? null : prev))
      showToast(
        freed.length
          ? `PIX expirou sem pagamento. Números ${formatNumbers(freed)} liberados.`
          : 'PIX expirou sem pagamento. Venda cancelada.',
      )
      void flushWorkspaceToCloud(useStore.getState().exportSnapshot()).catch(() => {})
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
                          : memberTab === id || (id === 'vendas' && openBlock)
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
                        setMemberTab(id)
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

      {/* MEMBER VIEW */}
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
                  {offlineContingency && (
                    <p className="hint full payment-rule contingency-hint">
                      Contingência: só dinheiro. O número fica vendido neste celular e sobe pra nuvem quando a rede
                      voltar. PIX liberado de novo com “Nuvem ok”.
                    </p>
                  )}
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
              </>
            )}
          </form>
          <div className="panel">
            <div className="panel-head">
              <div>
                <h2>Minhas vendas</h2>
              </div>
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
                  {visibleSales.map((s) => {
                    const charge = pixCharges.find((c) => c.saleId === s.id)
                    const cancelled = Boolean(s.cancelledAt)
                    const waitingPix =
                      !cancelled &&
                      s.paymentMethod === 'pix' &&
                      s.status === 'pendente' &&
                      !isPixChargeExpired(charge)
                    const canReopen = waitingPix && Boolean(charge?.copyPaste || charge?.qrCode)
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
                            ) : cancelled ? (
                              <>
                                <br />
                                <span className="pix-pending-hint">
                                  {s.cancelReason === 'expirado'
                                    ? 'QR venceu sem pagamento — números liberados'
                                    : 'Cancelado pelo vendedor — números liberados'}
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
                                onClick={() => void cancelPixFromList(s.id)}
                              >
                                Cancelar
                              </button>
                            </div>
                          ) : (
                            <span className={`badge ${cancelled ? 'falha' : s.status}`}>
                              {cancelled ? 'Cancelada' : statusLabel[s.status]}
                            </span>
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
                  if (!askProceed('Tem certeza que deseja limpar todos os dados?')) return
                  resetAll()
                  requestCloudPush()
                  showToast('Dados limpos.')
                }}
              >
                Limpar
              </button>
            </div>
          </div>
          <div className="hero-metrics">
            <article className="metric">
              <span>Membros</span>
              <strong>{members.length}</strong>
            </article>
            <article className="metric">
              <span>Vendas</span>
              <strong>{activeSales.length}</strong>
            </article>
            <article className="metric">
              <span>Esperado</span>
              <strong>{brl(activeSales.reduce((a, s) => a + s.totalAmount, 0))}</strong>
            </article>
            <article className="metric">
              <span>Recebido</span>
              <strong>{brl(activeSales.reduce((a, s) => a + s.paidAmount, 0))}</strong>
            </article>
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
          <h3>Sugestões TXID</h3>
          {suggestions.length === 0 && <p className="empty">Nenhuma sugestão agora.</p>}
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
          <p className="hint">Quem fez o quê — útil com vários ADMs na mesma equipe.</p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Quando</th>
                  <th>Quem</th>
                  <th>Ação</th>
                  <th>Detalhe</th>
                </tr>
              </thead>
              <tbody>
                {(auditLog || []).length === 0 && (
                  <tr>
                    <td colSpan={4}>
                      <p className="empty">Nenhuma ação registrada ainda.</p>
                    </td>
                  </tr>
                )}
                {(auditLog || []).slice(0, 40).map((a) => (
                  <tr key={a.id}>
                    <td>{new Date(a.at).toLocaleString('pt-BR')}</td>
                    <td>{a.actorName}</td>
                    <td>
                      <code>{a.action}</code>
                    </td>
                    <td>{a.detail || '—'}</td>
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
                  logAudit('membro.acesso_total', `${result.member.name} · ${email}`)
                  showToast(
                    `Membro ${result.member.name} criado com acesso total. No 1º login com e-mail, deve trocar a senha.`,
                  )
                } catch (err) {
                  logAudit('membro.criar', result.member.name)
                  showToast(
                    `Membro criado, mas falhou o acesso total: ${err instanceof Error ? err.message : 'erro'}`,
                  )
                }
              } else {
                logAudit('membro.criar', result.member.name)
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
              if (!askProceed()) return
              const fd = new FormData(e.currentTarget)
              const memberIdSel = String(fd.get('memberId') || '')
              if (!assignBlockIds.length) return showToast('Selecione ao menos um bloco.')
              let ok = 0
              for (const blockId of assignBlockIds) {
                const result = assignBlock(blockId, memberIdSel)
                if (!result.ok) return showToast(result.error || 'Erro')
                ok += 1
              }
              setAssignBlockIds([])
              e.currentTarget.reset()
              logAudit('bloco.atribuir', `${ok} bloco(s) → membro`)
              showToast(ok === 1 ? 'Bloco atribuído ao membro.' : `${ok} blocos atribuídos ao membro.`)
              requestCloudPush()
            }}
          >
            <div className="panel-head">
              <div>
                <h2>Atribuir bloco livre</h2>
                <p>Verde = livre. Cinza = já atribuído. Selecione um ou vários blocos de uma vez.</p>
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
                      const owner = members.find((m) => m.id === b.memberId)?.name || 'livre'
                      const selected = assignBlockIds.includes(b.id)
                      return (
                        <button
                          key={b.id}
                          type="button"
                          className={`transfer-block ${assigned ? 'assigned' : 'free'} ${selected ? 'selected' : ''}`}
                          disabled={assigned}
                          onClick={() => {
                            if (assigned) return
                            setAssignBlockIds((prev) =>
                              prev.includes(b.id) ? prev.filter((id) => id !== b.id) : [...prev, b.id],
                            )
                          }}
                        >
                          <strong>{b.label}</strong>
                          <span>
                            {b.fromNumber}–{b.toNumber} · {owner}
                          </span>
                          <span>{assigned ? 'Indisponível' : `${st.open} abertos`}</span>
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
                    <strong>{m.name}</strong>
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
                              <button
                                type="button"
                                className="btn btn-ghost"
                                onClick={() => {
                                  if (!askProceed()) return
                                  unassignBlock(b.id)
                                  requestCloudPush()
                                }}
                              >
                                liberar
                              </button>
                            </div>
                          )
                        })}
                    </div>
                    <button
                      type="button"
                      className="btn btn-danger"
                      onClick={() => {
                        if (!askProceed('Tem certeza que deseja remover este membro?')) return
                        removeMember(m.id)
                        requestCloudPush()
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
              if (!askProceed()) return
              const fd = new FormData(e.currentTarget)
              const toMember = String(fd.get('memberId') || '')
              if (!transferBlockIds.length) return showToast('Selecione ao menos um bloco.')
              let ok = 0
              for (const blockId of transferBlockIds) {
                const result = transferBlock(blockId, toMember)
                if (!result.ok) return showToast(result.error || 'Erro')
                ok += 1
              }
              setTransferBlockIds([])
              e.currentTarget.reset()
              showToast(ok === 1 ? 'Transferência registrada.' : `${ok} transferências registradas.`)
              logAudit('bloco.transferir', `${ok} bloco(s)`)
              requestCloudPush()
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
                          <span>{soldOut ? 'Vendido' : `${st.open} abertos`}</span>
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
                    <button type="button" className="btn btn-danger" onClick={() => { removeRaffle(r.id); setOpenEventId(null); requestCloudPush() }}>
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
                          <span className="block-open">{soldOut ? 'Vendido' : `${st.open} abertos`}</span>
                          <span className={owner ? 'owner-assigned' : 'owner-free'}>{owner || 'livre'}</span>
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
                {sales.map((s) => (
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
                      <span className={`badge ${s.cancelledAt ? 'falha' : s.status}`}>
                        {s.cancelledAt ? 'Cancelada' : statusLabel[s.status]}
                      </span>
                    </td>
                    <td>
                      {proofUrlForSale(s, pixCharges) ? (
                        <button
                          type="button"
                          className="btn-proof"
                          title="Abrir comprovante"
                          onClick={() => openProofUrl(proofUrlForSale(s, pixCharges))}
                        >
                          <ProofIcon />
                        </button>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))}
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
                    return (
                      <tr
                        key={c.id}
                        className={
                          c.status === 'expired' ||
                          c.status === 'cancelled' ||
                          sale?.status === 'divergente' ||
                          sale?.status === 'parcial'
                            ? 'txid-falha'
                            : undefined
                        }
                      >
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
                            className={`badge ${
                              c.status === 'expired' ||
                              c.status === 'cancelled' ||
                              sale?.status === 'divergente' ||
                              sale?.status === 'parcial'
                                ? 'falha'
                                : c.status === 'paid'
                                  ? 'quitado'
                                  : 'pendente'
                            }`}
                          >
                            {c.status === 'expired' ||
                            c.status === 'cancelled' ||
                            sale?.status === 'divergente' ||
                            sale?.status === 'parcial'
                              ? 'falha'
                              : c.status === 'paid'
                                ? 'pago'
                                : c.status}
                          </span>
                          {sale ? (
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
              <article className="metric">
                <span>Esperado</span>
                <strong>{brl(totals.expected)}</strong>
              </article>
              <article className="metric">
                <span>Recebido</span>
                <strong>{brl(totals.received)}</strong>
              </article>
              <article className="metric">
                <span>A prestar (equipe)</span>
                <strong>{brl(totals.dueTotal)}</strong>
              </article>
              <article className="metric">
                <span>Dinheiro loja</span>
                <strong>{brl(totals.cashLoja)}</strong>
              </article>
              <article className="metric">
                <span>PIX entidade</span>
                <strong>{brl(totals.pixEntidade)}</strong>
              </article>
              <article className="metric">
                <span>Números vendidos</span>
                <strong>{totals.soldCount}</strong>
              </article>
            </div>
          </div>

          {!selectedReport && (
            <div className="panel">
              <div className="panel-head">
                <div>
                  <h2>Equipe</h2>
                  <p>Toque no membro para abrir o dossiê completo. Ordenado por valor a prestar.</p>
                </div>
              </div>
              <div className="member-report-list">
                {reports.map((r) => {
                  const bs = memberBlockStats(r.member.id, reportEventId || undefined)
                  return (
                    <button
                      key={r.member.id}
                      type="button"
                      className="member-report-row"
                      onClick={() => {
                        setReportMemberId(r.member.id)
                        setReportDetail('resumo')
                      }}
                    >
                      <div className="member-report-main">
                        <strong>{r.member.name}</strong>
                        <span className="hint">
                          {r.saleCount} vendas · {r.soldCount} nº · {bs.blocks} blocos
                          {bs.openNumbers > 0 ? ` · ${bs.openNumbers} abertos` : ''}
                        </span>
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
                      <strong>{brl(selectedReport.expected)}</strong>
                    </article>
                    <article className="metric">
                      <span>Recebido</span>
                      <strong>{brl(selectedReport.received)}</strong>
                    </article>
                    <article className="metric">
                      <span>Em aberto (vendas)</span>
                      <strong>{brl(selectedReport.openAmount)}</strong>
                    </article>
                    <article className="metric due-metric">
                      <span>A prestar à entidade</span>
                      <strong>{brl(selectedReport.dueTotal)}</strong>
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
                          return (
                            <tr key={b.id}>
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
                            <tr key={t.id}>
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
          onCancel={() => void cancelPendingPixSale()}
          onClosePaid={finishPaidPixSale}
          onNewSale={isAdmin ? undefined : keepPixAndStartNewSale}
        />
      )}
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
      <TeamChat />
    </div>
  )
}
