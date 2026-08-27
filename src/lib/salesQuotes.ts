/** Frases curtas de venda — uma por dia, igual para todo o time. */
const SALES_QUOTES = [
  'Venda é atitude',
  'Menos desculpas, mais ação',
  'Quem corre atrás chega primeiro',
  'Toda não te aproxima do próximo sim',
  'O que importa é a ação, não a perfeição',
  'Quem insiste, conquista',
  'A objeção é o começo da venda',
  'Grandes resultados nascem de pequenas ações',
  'Quem acredita, insiste',
  'Cada abordagem é uma nova chance',
  'Meta não se espera, se constrói',
  'Hoje é dia de fechar',
  'Rejeição é sinal de tentativa',
  'Seja a solução, não só o vendedor',
  'Quem não desiste, vende',
]

export function todaySalesQuote() {
  const now = new Date()
  const start = Date.UTC(now.getFullYear(), 0, 0)
  const day = Math.floor((Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - start) / 86_400_000)
  return SALES_QUOTES[((day % SALES_QUOTES.length) + SALES_QUOTES.length) % SALES_QUOTES.length]
}

export function formatDrawDate(d: Date) {
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' })
}

/** yyyy-mm-dd no fuso local, sem recuar um dia no Brasil. */
export function parseDrawDate(raw?: string | null) {
  if (!raw) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw)
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? null : d
}
