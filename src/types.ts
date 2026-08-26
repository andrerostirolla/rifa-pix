export type PaymentStatus = 'pendente' | 'parcial' | 'quitado' | 'divergente'
export type PaymentMethod = 'pix' | 'dinheiro'
export type PixDestination = 'entidade' | 'vendedor'
/** Destino do dinheiro físico: com o vendedor ou já na loja/entidade */
export type CashDestination = 'vendedor' | 'loja'
export type SessionRole = 'admin' | 'member'
export type BlockTransferKind = 'assign' | 'transfer' | 'unassign'

export interface Raffle {
  id: string
  name: string
  ticketPrice: number
  totalNumbers: number
  prize: string
  eventName: string
  createdAt: string
  active: boolean
  /** Quantidade de blocos (ex.: 4) */
  blockCount?: number
  /** Números/cartelas por bloco (ex.: 50) */
  numbersPerBlock?: number
  /** Data de início das vendas (yyyy-mm-dd) */
  startDate?: string
  /** Data do sorteio (yyyy-mm-dd) */
  drawDate?: string
}

export interface Member {
  id: string
  name: string
  phone?: string
  pin: string
  active: boolean
  createdAt: string
}

/** Bloco de números (ex.: Bloco 1 = 01–50) */
export interface Block {
  id: string
  raffleId: string
  index: number
  label: string
  fromNumber: number
  toNumber: number
  memberId?: string
  createdAt: string
}

/** Legado — faixas livres; preferir Block */
export interface NumberRange {
  id: string
  memberId: string
  raffleId: string
  fromNumber: number
  toNumber: number
  createdAt: string
}

export interface Sale {
  id: string
  raffleId: string
  memberId: string
  buyerName: string
  buyerPhone?: string
  numbers: number[]
  totalAmount: number
  paidAmount: number
  status: PaymentStatus
  paymentMethod: PaymentMethod
  pixDestination?: PixDestination
  /** Só para dinheiro: ficou com o vendedor ou já foi pra loja */
  cashDestination?: CashDestination
  notes?: string
  createdAt: string
  /** Bloco de origem da venda, quando aplicável */
  blockId?: string
  /** Comprovante no Storage (caminho no bucket) */
  proofPath?: string
  /** Legado: data URL embutida (migrar para proofPath) */
  proofImageDataUrl?: string
  /** Prestação de contas em dinheiro liquidada com a entidade */
  cashSettledAt?: string
  cashSettlementNote?: string
  /** PIX cancelado (QR venceu ou o membro cancelou): números voltam a ficar livres */
  cancelledAt?: string
  cancelReason?: 'expirado' | 'membro'
  /** Motivo escrito pelo membro ao cancelar */
  cancelNote?: string
  /** Quem cancelou (membro ou ADM que estava logado) */
  cancelledBy?: string
}

/** Rastro de atribuição / transferência / liberação de bloco */
export interface BlockTransfer {
  id: string
  blockId: string
  raffleId: string
  fromMemberId?: string
  toMemberId?: string
  kind: BlockTransferKind
  createdAt: string
  note?: string
}

export interface PixPayment {
  id: string
  amount: number
  paidAt: string
  payerName: string
  txid?: string
  endToEndId?: string
  notes?: string
  matchedSaleId?: string
  allocatedAmount: number
  createdAt: string
}

export interface AmortizationEntry {
  id: string
  saleId: string
  pixPaymentId: string
  amount: number
  createdAt: string
  note?: string
}

export interface PixCharge {
  id: string
  saleId: string
  txid: string
  amount: number
  status: 'pending' | 'paid' | 'expired' | 'cancelled'
  createdAt: string
  paidAt?: string
  note?: string
  proofImageDataUrl?: string
  copyPaste?: string
  qrCode?: string
  provider?: string
  expiresAt?: string
}

export interface MemberSettlement {
  id: string
  memberId: string
  raffleId?: string
  amount: number
  kind: 'dinheiro' | 'pix_vendedor'
  note?: string
  createdAt: string
  /** Vendas em dinheiro liquidadas neste fechamento */
  saleIds?: string[]
}

export interface AuditEntry {
  id: string
  at: string
  actorName: string
  action: string
  detail?: string
  /** Campos extras mostrados no popover de detalhes (rótulo → valor) */
  meta?: Record<string, string>
}

export interface AppState {
  raffles: Raffle[]
  members: Member[]
  blocks: Block[]
  numberRanges: NumberRange[]
  sales: Sale[]
  pixPayments: PixPayment[]
  amortizations: AmortizationEntry[]
  pixCharges: PixCharge[]
  memberSettlements: MemberSettlement[]
  blockTransfers: BlockTransfer[]
  auditLog?: AuditEntry[]
}
