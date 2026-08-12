export type ParsedPixRow = {
  paidAt: string
  amount: number
  payerName: string
  txid?: string
  endToEndId?: string
  notes?: string
  raw: string
}

function normalizeHeader(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
}

function parseAmount(raw: string): number | null {
  const cleaned = raw.trim().replace(/[R$\s]/gi, '')
  if (!cleaned) return null
  // 1.234,56 or 1234,56
  if (/^-?\d{1,3}(\.\d{3})*,\d{2}$/.test(cleaned) || /^-?\d+,\d{2}$/.test(cleaned)) {
    return Number(cleaned.replace(/\./g, '').replace(',', '.'))
  }
  // 1234.56
  if (/^-?\d+(\.\d+)?$/.test(cleaned)) return Number(cleaned)
  // 1,234.56
  if (/^-?\d{1,3}(,\d{3})*\.\d{2}$/.test(cleaned)) {
    return Number(cleaned.replace(/,/g, ''))
  }
  return null
}

function parseDate(raw: string): string | null {
  const value = raw.trim()
  if (!value) return null
  // yyyy-mm-dd
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10)
  // dd/mm/yyyy or dd-mm-yyyy
  const br = value.match(/^(\d{2})[/-](\d{2})[/-](\d{4})/)
  if (br) return `${br[3]}-${br[2]}-${br[1]}`
  // dd/mm/yy
  const br2 = value.match(/^(\d{2})[/-](\d{2})[/-](\d{2})/)
  if (br2) {
    const year = Number(br2[3]) < 50 ? `20${br2[3]}` : `19${br2[3]}`
    return `${year}-${br2[2]}-${br2[1]}`
  }
  return null
}

function detectDelimiter(line: string) {
  const commas = (line.match(/,/g) || []).length
  const semis = (line.match(/;/g) || []).length
  const tabs = (line.match(/\t/g) || []).length
  if (tabs >= commas && tabs >= semis) return '\t'
  if (semis >= commas) return ';'
  return ','
}

function splitCsvLine(line: string, delimiter: string) {
  const out: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"'
        i += 1
      } else {
        inQuotes = !inQuotes
      }
      continue
    }
    if (ch === delimiter && !inQuotes) {
      out.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  out.push(cur)
  return out.map((c) => c.trim())
}

type ColumnMap = {
  date?: number
  amount?: number
  name?: number
  txid?: number
  e2e?: number
  notes?: number
}

function mapColumns(headers: string[]): ColumnMap {
  const normalized = headers.map(normalizeHeader)
  const find = (...candidates: string[]) => {
    const idx = normalized.findIndex((h) => candidates.some((c) => h.includes(c)))
    return idx >= 0 ? idx : undefined
  }
  return {
    date: find('data', 'date', 'datapagamento', 'datalancamento'),
    amount: find('valor', 'amount', 'value', 'quantia'),
    name: find('nome', 'pagador', 'remetente', 'origem', 'contraparte', 'payer', 'descricao', 'historico'),
    txid: find('txid', 'idtransacao', 'identificador'),
    e2e: find('endtoend', 'e2e', 'idfimafm', 'endtoendid'),
    notes: find('obs', 'observacao', 'memo', 'complemento'),
  }
}

export function parsePixCsv(text: string): { rows: ParsedPixRow[]; errors: string[] } {
  const cleaned = text.replace(/^\uFEFF/, '').trim()
  if (!cleaned) return { rows: [], errors: ['Arquivo vazio.'] }

  const lines = cleaned.split(/\r?\n/).filter((l) => l.trim())
  if (lines.length < 2) return { rows: [], errors: ['CSV precisa de cabeçalho e ao menos uma linha.'] }

  const delimiter = detectDelimiter(lines[0])
  const headers = splitCsvLine(lines[0], delimiter)
  const cols = mapColumns(headers)

  if (cols.date === undefined || cols.amount === undefined || cols.name === undefined) {
    return {
      rows: [],
      errors: [
        'Não reconheci as colunas. Use cabeçalhos com Data, Valor e Nome/Pagador (ou Descrição).',
      ],
    }
  }

  const rows: ParsedPixRow[] = []
  const errors: string[] = []

  for (let i = 1; i < lines.length; i += 1) {
    const cells = splitCsvLine(lines[i], delimiter)
    if (cells.every((c) => !c)) continue
    const paidAt = parseDate(cells[cols.date] || '')
    const amount = parseAmount(cells[cols.amount] || '')
    const payerName = (cells[cols.name] || '').trim()
    if (!paidAt || amount === null || !payerName) {
      errors.push(`Linha ${i + 1}: data/valor/nome inválidos.`)
      continue
    }
    // Only credits (positive). Skip negatives/debits.
    if (amount <= 0) continue

    const txid = cols.txid !== undefined ? cells[cols.txid]?.trim() : undefined
    const endToEndId = cols.e2e !== undefined ? cells[cols.e2e]?.trim() : undefined
    const notes = cols.notes !== undefined ? cells[cols.notes]?.trim() : undefined

    rows.push({
      paidAt,
      amount,
      payerName,
      txid: txid || undefined,
      endToEndId: endToEndId || undefined,
      notes: notes || undefined,
      raw: lines[i],
    })
  }

  return { rows, errors }
}

export const SAMPLE_CSV = `Data;Valor;Nome;TXID
11/08/2026;30,00;Maria Souza;PIX-MARIA-30
10/08/2026;10,00;Joao Lima;PIX-JOAO-10
09/08/2026;50,00;Carlos Mendes;PIX-CARLOS-50
`
