import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type {
  AmortizationEntry,
  AppState,
  PaymentStatus,
  PixCharge,
  PixPayment,
  Raffle,
  Sale,
} from './types'
import { makeLocalTxid, previewTxidMatches } from './txidMatch'
import type { ParsedPixRow } from './csvImport'

function uid() {
  return crypto.randomUUID()
}

function saleStatus(total: number, paid: number): PaymentStatus {
  if (paid <= 0) return 'pendente'
  if (paid + 0.001 < total) return 'parcial'
  if (Math.abs(paid - total) < 0.01) return 'quitado'
  return 'divergente'
}

type Store = AppState & {
  addRaffle: (input: Omit<Raffle, 'id' | 'createdAt'>) => void
  removeRaffle: (id: string) => void
  addSale: (input: {
    raffleId: string
    buyerName: string
    buyerPhone?: string
    numbers: number[]
    notes?: string
  }) => void
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
  attachTxidToSale: (saleId: string, txid: string, amount?: number) => { ok: true; charge: PixCharge } | { ok: false; error: string }
  removePix: (id: string) => void
  amortize: (saleId: string, pixPaymentId: string, amount: number, note?: string) => {
    ok: boolean
    error?: string
  }
  autoMatchSuggestions: () => Array<{
    saleId: string
    pixPaymentId: string
    amount: number
    reason: string
  }>
  exportSnapshot: () => AppState
  importSnapshot: (data: AppState) => { ok: boolean; error?: string }
  seedDemo: () => void
  resetAll: () => void
}

const empty: AppState = {
  raffles: [],
  sales: [],
  pixPayments: [],
  amortizations: [],
  pixCharges: [],
}

export const useStore = create<Store>()(
  persist(
    (set, get) => ({
      ...empty,

      addRaffle: (input) =>
        set((s) => ({
          raffles: [
            {
              ...input,
              id: uid(),
              createdAt: new Date().toISOString(),
            },
            ...s.raffles,
          ],
        })),

      removeRaffle: (id) =>
        set((s) => ({
          raffles: s.raffles.filter((r) => r.id !== id),
          sales: s.sales.filter((sale) => sale.raffleId !== id),
        })),

      addSale: (input) => {
        const raffle = get().raffles.find((r) => r.id === input.raffleId)
        if (!raffle) return
        const totalAmount = input.numbers.length * raffle.ticketPrice
        const sale: Sale = {
          id: uid(),
          raffleId: input.raffleId,
          buyerName: input.buyerName.trim(),
          buyerPhone: input.buyerPhone?.trim() || undefined,
          numbers: [...input.numbers].sort((a, b) => a - b),
          totalAmount,
          paidAmount: 0,
          status: 'pendente',
          notes: input.notes?.trim() || undefined,
          createdAt: new Date().toISOString(),
        }
        set((s) => ({ sales: [sale, ...s.sales] }))
      },

      removeSale: (id) =>
        set((s) => {
          const linked = s.amortizations.filter((a) => a.saleId === id)
          const pixAdjust = new Map<string, number>()
          for (const a of linked) {
            pixAdjust.set(a.pixPaymentId, (pixAdjust.get(a.pixPaymentId) ?? 0) + a.amount)
          }
          return {
            sales: s.sales.filter((sale) => sale.id !== id),
            amortizations: s.amortizations.filter((a) => a.saleId !== id),
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
        if (created.length) {
          set((s) => ({ pixPayments: [...created, ...s.pixPayments] }))
        }
        return { imported: created.length, skipped }
      },

      importCsvAndSettleByTxid: (rows) => {
        const bulk = get().addPixBulk(rows)
        const state = get()
        const matches = previewTxidMatches(
          rows,
          state.pixCharges.map((c) => ({
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
          const result = get().amortize(
            match.saleId,
            pix.id,
            match.settleAmount,
            `Baixa automática por ${match.confidence === 'txid' ? 'TXID' : 'End-to-end'}`,
          )
          if (!result.ok) continue
          settled += 1
          set((s) => ({
            pixCharges: s.pixCharges.map((c) =>
              c.id === match.chargeId
                ? { ...c, status: 'paid' as const, paidAt: new Date().toISOString() }
                : c,
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
        if (!(value > 0) || value > open + 0.009) return { ok: false, error: 'Valor inválido.' }
        const charge: PixCharge = {
          id: uid(),
          saleId,
          txid: makeLocalTxid(),
          amount: value,
          status: 'pending',
          createdAt: new Date().toISOString(),
          note: 'Use este TXID na cobrança PIX / conferência do extrato',
        }
        set((s) => ({ pixCharges: [charge, ...s.pixCharges] }))
        return { ok: true, charge }
      },

      attachTxidToSale: (saleId, txid, amount) => {
        const clean = txid.trim()
        if (!clean) return { ok: false, error: 'Informe o TXID.' }
        const sale = get().sales.find((s) => s.id === saleId)
        if (!sale) return { ok: false, error: 'Venda não encontrada.' }
        const open = sale.totalAmount - sale.paidAmount
        if (open <= 0.009) return { ok: false, error: 'Venda já quitada.' }
        const value = amount ?? open
        const exists = get().pixCharges.some((c) => c.txid.toLowerCase() === clean.toLowerCase())
        if (exists) return { ok: false, error: 'TXID já cadastrado.' }
        const charge: PixCharge = {
          id: uid(),
          saleId,
          txid: clean,
          amount: value,
          status: 'pending',
          createdAt: new Date().toISOString(),
          note: 'TXID informado manualmente (banco/PSP)',
        }
        set((s) => ({ pixCharges: [charge, ...s.pixCharges] }))
        return { ok: true, charge }
      },

      removePix: (id) =>
        set((s) => {
          const linked = s.amortizations.filter((a) => a.pixPaymentId === id)
          const saleAdjust = new Map<string, number>()
          for (const a of linked) {
            saleAdjust.set(a.saleId, (saleAdjust.get(a.saleId) ?? 0) + a.amount)
          }
          return {
            pixPayments: s.pixPayments.filter((p) => p.id !== id),
            amortizations: s.amortizations.filter((a) => a.pixPaymentId !== id),
            sales: s.sales.map((sale) => {
              const subtract = saleAdjust.get(sale.id)
              if (!subtract) return sale
              const paidAmount = Math.max(0, sale.paidAmount - subtract)
              return {
                ...sale,
                paidAmount,
                status: saleStatus(sale.totalAmount, paidAmount),
              }
            }),
          }
        }),

      amortize: (saleId, pixPaymentId, amount, note) => {
        const state = get()
        const sale = state.sales.find((s) => s.id === saleId)
        const pix = state.pixPayments.find((p) => p.id === pixPaymentId)
        if (!sale || !pix) return { ok: false, error: 'Venda ou PIX não encontrado.' }
        if (amount <= 0) return { ok: false, error: 'Valor deve ser maior que zero.' }

        const saleOpen = Math.max(0, sale.totalAmount - sale.paidAmount)
        const pixOpen = Math.max(0, pix.amount - pix.allocatedAmount)
        if (amount - saleOpen > 0.009) {
          return { ok: false, error: `Venda só tem R$ ${saleOpen.toFixed(2)} em aberto.` }
        }
        if (amount - pixOpen > 0.009) {
          return { ok: false, error: `PIX só tem R$ ${pixOpen.toFixed(2)} disponível.` }
        }

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
            return {
              ...item,
              paidAmount,
              status: saleStatus(item.totalAmount, paidAmount),
            }
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
        const openSales = sales
          .filter((s) => s.paidAmount < s.totalAmount - 0.009)
          .map((s) => ({
            ...s,
            open: s.totalAmount - s.paidAmount,
          }))
        const openPix = pixPayments
          .filter((p) => p.allocatedAmount < p.amount - 0.009)
          .map((p) => ({
            ...p,
            open: p.amount - p.allocatedAmount,
          }))

        const suggestions: Array<{
          saleId: string
          pixPaymentId: string
          amount: number
          reason: string
        }> = []
        const usedPix = new Set<string>()
        const usedSales = new Set<string>()

        const pendingCharges = pixCharges.filter((c) => c.status === 'pending')

        // 1) Highest confidence: TXID / end-to-end exact match via charge
        for (const charge of pendingCharges) {
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
            amount: Math.min(sale.open, pix.open, charge.amount),
            reason: 'TXID / End-to-end idêntico',
          })
          usedPix.add(pix.id)
          usedSales.add(sale.id)
        }

        for (const sale of openSales) {
          if (usedSales.has(sale.id)) continue
          const name = sale.buyerName.trim().toLowerCase()
          const exact = openPix.find(
            (p) =>
              !usedPix.has(p.id) &&
              Math.abs(p.open - sale.open) < 0.01 &&
              p.payerName.trim().toLowerCase() === name,
          )
          if (exact) {
            suggestions.push({
              saleId: sale.id,
              pixPaymentId: exact.id,
              amount: sale.open,
              reason: 'Nome + valor em aberto iguais',
            })
            usedPix.add(exact.id)
            usedSales.add(sale.id)
            continue
          }
          const byAmount = openPix.find(
            (p) => !usedPix.has(p.id) && Math.abs(p.open - sale.open) < 0.01,
          )
          if (byAmount) {
            suggestions.push({
              saleId: sale.id,
              pixPaymentId: byAmount.id,
              amount: sale.open,
              reason: 'Valor em aberto igual',
            })
            usedPix.add(byAmount.id)
            usedSales.add(sale.id)
          }
        }

        return suggestions
      },

      exportSnapshot: () => {
        const { raffles, sales, pixPayments, amortizations, pixCharges } = get()
        return { raffles, sales, pixPayments, amortizations, pixCharges }
      },

      importSnapshot: (data) => {
        if (!data || !Array.isArray(data.raffles) || !Array.isArray(data.sales) || !Array.isArray(data.pixPayments) || !Array.isArray(data.amortizations)) {
          return { ok: false, error: 'Arquivo de backup inválido.' }
        }
        set({
          raffles: data.raffles,
          sales: data.sales,
          pixPayments: data.pixPayments,
          amortizations: data.amortizations,
          pixCharges: Array.isArray(data.pixCharges) ? data.pixCharges : [],
        })
        return { ok: true }
      },

      seedDemo: () => {
        const raffleId = uid()
        const saleA = uid()
        const saleB = uid()
        const saleC = uid()
        const pix2 = uid()
        const pix3 = uid()
        const now = new Date()
        const d = (daysAgo: number) => {
          const x = new Date(now)
          x.setDate(x.getDate() - daysAgo)
          return x.toISOString()
        }

        set({
          raffles: [
            {
              id: raffleId,
              name: 'Rifa Churrasco da Turma',
              ticketPrice: 10,
              totalNumbers: 100,
              prize: 'Kit churrasco + R$ 200',
              createdAt: d(5),
            },
          ],
          sales: [
            {
              id: saleA,
              raffleId,
              buyerName: 'Maria Souza',
              buyerPhone: '11999990001',
              numbers: [7, 8, 9],
              totalAmount: 30,
              paidAmount: 0,
              status: 'pendente',
              createdAt: d(3),
            },
            {
              id: saleB,
              raffleId,
              buyerName: 'João Lima',
              buyerPhone: '11999990002',
              numbers: [21, 22],
              totalAmount: 20,
              paidAmount: 10,
              status: 'parcial',
              createdAt: d(2),
            },
            {
              id: saleC,
              raffleId,
              buyerName: 'Ana Paula',
              numbers: [55],
              totalAmount: 10,
              paidAmount: 10,
              status: 'quitado',
              createdAt: d(1),
            },
          ],
          pixPayments: [
            {
              id: pix2,
              amount: 10,
              paidAt: d(1).slice(0, 10),
              payerName: 'Joao Lima',
              txid: 'PIX-JOAO-10',
              allocatedAmount: 10,
              matchedSaleId: saleB,
              createdAt: d(1),
            },
            {
              id: pix3,
              amount: 10,
              paidAt: d(1).slice(0, 10),
              payerName: 'Ana Paula Costa',
              endToEndId: 'E1234567820260811XXXX',
              allocatedAmount: 10,
              matchedSaleId: saleC,
              createdAt: d(1),
            },
          ],
          amortizations: [
            {
              id: uid(),
              saleId: saleB,
              pixPaymentId: pix2,
              amount: 10,
              createdAt: d(1),
              note: 'Primeira parcela',
            },
            {
              id: uid(),
              saleId: saleC,
              pixPaymentId: pix3,
              amount: 10,
              createdAt: d(1),
            },
          ],
          pixCharges: [
            {
              id: uid(),
              saleId: saleA,
              txid: 'PIX-MARIA-30',
              amount: 30,
              status: 'pending',
              createdAt: d(3),
              note: 'Importe o CSV de exemplo na aba PIX para baixar automaticamente',
            },
          ],
        })
      },

      resetAll: () => set({ ...empty }),
    }),
    {
      name: 'rifa-pix-v1',
      merge: (persisted, current) => {
        const p = (persisted || {}) as Partial<AppState>
        return {
          ...current,
          ...p,
          pixCharges: Array.isArray(p.pixCharges) ? p.pixCharges : [],
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
