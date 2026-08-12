import type { ParsedPixRow } from './csvImport'

export type ChargeLike = {
  id: string
  saleId: string
  txid: string
  amount: number
  status: 'pending' | 'paid' | 'expired' | 'cancelled'
}

export type TxidMatchPreview = {
  rowIndex: number
  row: ParsedPixRow
  chargeId: string
  saleId: string
  txid: string
  settleAmount: number
  confidence: 'txid' | 'endToEnd'
}

function norm(value?: string) {
  return (value || '').trim().toLowerCase()
}

/** Preview which CSV rows will settle sales by exact txid / end-to-end. */
export function previewTxidMatches(rows: ParsedPixRow[], charges: ChargeLike[]): TxidMatchPreview[] {
  const pending = charges.filter((c) => c.status === 'pending')
  const byTxid = new Map(pending.map((c) => [norm(c.txid), c]))
  const usedCharges = new Set<string>()
  const matches: TxidMatchPreview[] = []

  rows.forEach((row, rowIndex) => {
    const txid = norm(row.txid)
    const e2e = norm(row.endToEndId)
    let charge = txid ? byTxid.get(txid) : undefined
    let confidence: 'txid' | 'endToEnd' = 'txid'
    if (!charge && e2e) {
      charge = byTxid.get(e2e)
      confidence = 'endToEnd'
    }
    if (!charge || usedCharges.has(charge.id)) return
    usedCharges.add(charge.id)
    const settleAmount = Math.min(row.amount, charge.amount)
    matches.push({
      rowIndex,
      row,
      chargeId: charge.id,
      saleId: charge.saleId,
      txid: charge.txid,
      settleAmount,
      confidence,
    })
  })

  return matches
}

export function makeLocalTxid() {
  return `rifa${crypto.randomUUID().replace(/-/g, '')}`.slice(0, 25)
}
