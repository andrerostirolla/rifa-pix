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
  /** Evento/campanha (ex.: Festa Junina 2026) */
  eventName: string
  createdAt: string
  active: boolean
}

export interface Member {
  id: string
  name: string
  phone?: string
  /** PIN numérico simples para login do membro */
  pin: string
  active: boolean
  createdAt: string
}

/** Faixa de números do membro em uma rifa/evento */
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
  /** Só faz sentido para PIX */
  pixDestination?: PixDestination
  notes?: string
  createdAt: string
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

/** Prestação de contas do membro (dinheiro/PIX na conta dele entregue à entidade) */
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
  numberRanges: NumberRange[]
  sales: Sale[]
  pixPayments: PixPayment[]
  amortizations: AmortizationEntry[]
  pixCharges: PixCharge[]
  memberSettlements: MemberSettlement[]
}
