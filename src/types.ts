export type PaymentStatus = 'pendente' | 'parcial' | 'quitado' | 'divergente'
export type PaymentMethod = 'pix' | 'dinheiro'
export type PixDestination = 'entidade' | 'vendedor'
export type SessionRole = 'admin' | 'member'

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
  notes?: string
  createdAt: string
  /** Bloco de origem da venda, quando aplicável */
  blockId?: string
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
}

export interface MemberSettlement {
  id: string
  memberId: string
  raffleId?: string
  amount: number
  kind: 'dinheiro' | 'pix_vendedor'
  note?: string
  createdAt: string
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
}
