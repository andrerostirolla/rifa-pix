export type PaymentStatus = 'pendente' | 'parcial' | 'quitado' | 'divergente'

export interface Raffle {
  id: string
  name: string
  ticketPrice: number
  totalNumbers: number
  prize: string
  createdAt: string
}

export interface Sale {
  id: string
  raffleId: string
  buyerName: string
  buyerPhone?: string
  numbers: number[]
  totalAmount: number
  paidAmount: number
  status: PaymentStatus
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
}

export interface AppState {
  raffles: Raffle[]
  sales: Sale[]
  pixPayments: PixPayment[]
  amortizations: AmortizationEntry[]
  pixCharges: PixCharge[]
}
