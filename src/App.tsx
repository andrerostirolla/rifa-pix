import { useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { getAuthRecord, isAuthenticated, logout } from './auth'
import { parsePixCsv, SAMPLE_CSV } from './csvImport'
import { LoginScreen } from './LoginScreen'
import { brl, formatNumbers, useStore } from './store'
import type { PaymentStatus } from './types'

type Tab = 'painel' | 'rifas' | 'vendas' | 'pix' | 'amortizacao'

const statusLabel: Record<PaymentStatus, string> = {
  pendente: 'Pendente',
  parcial: 'Parcial',
  quitado: 'Quitado',
  divergente: 'Divergente',
}

function todayInput() {
  return new Date().toISOString().slice(0, 10)
}

function parseNumbers(raw: string, max: number): { ok: true; numbers: number[] } | { ok: false; error: string } {
  const parts = raw
    .split(/[\s,;]+/)
    .map((p) => p.trim())
    .filter(Boolean)
  if (!parts.length) return { ok: false, error: 'Informe ao menos um número.' }
  const numbers: number[] = []
  for (const part of parts) {
    const n = Number(part)
    if (!Number.isInteger(n) || n < 1 || n > max) {
      return { ok: false, error: `Número inválido: ${part}` }
    }
    numbers.push(n)
  }
  const unique = [...new Set(numbers)]
  if (unique.length !== numbers.length) return { ok: false, error: 'Há números repetidos na venda.' }
  return { ok: true, numbers: unique }
}

export default function App() {
  const [authed, setAuthed] = useState(() => isAuthenticated())
  const [tab, setTab] = useState<Tab>('painel')
  const [toast, setToast] = useState<string | null>(null)
  const [csvText, setCsvText] = useState('')
  const [importPreview, setImportPreview] = useState<ReturnType<typeof parsePixCsv> | null>(null)

  const raffles = useStore((s) => s.raffles)
  const sales = useStore((s) => s.sales)
  const pixPayments = useStore((s) => s.pixPayments)
  const amortizations = useStore((s) => s.amortizations)
  const addRaffle = useStore((s) => s.addRaffle)
  const removeRaffle = useStore((s) => s.removeRaffle)
  const addSale = useStore((s) => s.addSale)
  const removeSale = useStore((s) => s.removeSale)
  const addPix = useStore((s) => s.addPix)
  const addPixBulk = useStore((s) => s.addPixBulk)
  const removePix = useStore((s) => s.removePix)
  const amortize = useStore((s) => s.amortize)
  const autoMatchSuggestions = useStore((s) => s.autoMatchSuggestions)
  const exportSnapshot = useStore((s) => s.exportSnapshot)
  const importSnapshot = useStore((s) => s.importSnapshot)
  const seedDemo = useStore((s) => s.seedDemo)
  const resetAll = useStore((s) => s.resetAll)

  const showToast = (msg: string) => {
    setToast(msg)
    window.setTimeout(() => setToast(null), 2800)
  }

  const metrics = useMemo(() => {
    const expected = sales.reduce((acc, s) => acc + s.totalAmount, 0)
    const received = sales.reduce((acc, s) => acc + s.paidAmount, 0)
    const pixOpen = pixPayments.reduce((acc, p) => acc + Math.max(0, p.amount - p.allocatedAmount), 0)
    const openSales = expected - received
    return { expected, received, openSales, pixOpen }
  }, [sales, pixPayments])

  const suggestions = useMemo(() => autoMatchSuggestions(), [sales, pixPayments, amortizations, autoMatchSuggestions])

  const takenNumbers = useMemo(() => {
    const map = new Map<string, Set<number>>()
    for (const sale of sales) {
      const set = map.get(sale.raffleId) ?? new Set<number>()
      sale.numbers.forEach((n) => set.add(n))
      map.set(sale.raffleId, set)
    }
    return map
  }, [sales])

  if (!authed) {
    return <LoginScreen onAuthenticated={() => setAuthed(true)} />
  }

  const organizer = getAuthRecord()?.organizerName || 'Organizador'

  const onCreateRaffle = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    const name = String(fd.get('name') || '').trim()
    const prize = String(fd.get('prize') || '').trim()
    const ticketPrice = Number(fd.get('ticketPrice'))
    const totalNumbers = Number(fd.get('totalNumbers'))
    if (!name || !prize || !(ticketPrice > 0) || !(totalNumbers > 0)) {
      showToast('Preencha a rifa corretamente.')
      return
    }
    addRaffle({ name, prize, ticketPrice, totalNumbers })
    e.currentTarget.reset()
    showToast('Rifa criada.')
  }

  const onCreateSale = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    const raffleId = String(fd.get('raffleId') || '')
    const raffle = raffles.find((r) => r.id === raffleId)
    if (!raffle) {
      showToast('Selecione uma rifa.')
      return
    }
    const parsed = parseNumbers(String(fd.get('numbers') || ''), raffle.totalNumbers)
    if (!parsed.ok) {
      showToast(parsed.error)
      return
    }
    const taken = takenNumbers.get(raffleId) ?? new Set()
    const clash = parsed.numbers.find((n) => taken.has(n))
    if (clash !== undefined) {
      showToast(`Número ${String(clash).padStart(2, '0')} já vendido.`)
      return
    }
    addSale({
      raffleId,
      buyerName: String(fd.get('buyerName') || ''),
      buyerPhone: String(fd.get('buyerPhone') || ''),
      numbers: parsed.numbers,
      notes: String(fd.get('notes') || ''),
    })
    e.currentTarget.reset()
    showToast('Venda registrada.')
  }

  const onCreatePix = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    const amount = Number(fd.get('amount'))
    const payerName = String(fd.get('payerName') || '').trim()
    const paidAt = String(fd.get('paidAt') || '')
    if (!(amount > 0) || !payerName || !paidAt) {
      showToast('Informe pagador, data e valor do PIX.')
      return
    }
    addPix({
      amount,
      payerName,
      paidAt,
      txid: String(fd.get('txid') || ''),
      endToEndId: String(fd.get('endToEndId') || ''),
      notes: String(fd.get('notes') || ''),
    })
    e.currentTarget.reset()
    showToast('PIX lançado no extrato.')
  }

  const onAmortize = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    const saleId = String(fd.get('saleId') || '')
    const pixPaymentId = String(fd.get('pixPaymentId') || '')
    const amount = Number(fd.get('amount'))
    const note = String(fd.get('note') || '')
    const result = amortize(saleId, pixPaymentId, amount, note)
    if (!result.ok) {
      showToast(result.error || 'Falha na amortização.')
      return
    }
    e.currentTarget.reset()
    showToast('Amortização aplicada.')
  }

  const applySuggestion = (saleId: string, pixPaymentId: string, amount: number) => {
    const result = amortize(saleId, pixPaymentId, amount, 'Conferência automática')
    showToast(result.ok ? 'Sugestão aplicada.' : result.error || 'Não foi possível aplicar.')
  }

  const raffleName = (id: string) => raffles.find((r) => r.id === id)?.name || '—'

  const previewCsv = (text: string) => {
    setCsvText(text)
    setImportPreview(parsePixCsv(text))
  }

  const onFileCsv = async (file: File | null) => {
    if (!file) return
    const text = await file.text()
    previewCsv(text)
  }

  const confirmImport = () => {
    if (!importPreview?.rows.length) {
      showToast('Nada para importar.')
      return
    }
    const result = addPixBulk(importPreview.rows)
    showToast(`Importados ${result.imported}. Ignorados (duplicados): ${result.skipped}.`)
    setCsvText('')
    setImportPreview(null)
  }

  const downloadBackup = () => {
    const blob = new Blob([JSON.stringify(exportSnapshot(), null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `rifapix-backup-${todayInput()}.json`
    a.click()
    URL.revokeObjectURL(url)
    showToast('Backup baixado.')
  }

  const onBackupFile = async (file: File | null) => {
    if (!file) return
    try {
      const data = JSON.parse(await file.text())
      const result = importSnapshot(data)
      showToast(result.ok ? 'Backup restaurado.' : result.error || 'Falha ao restaurar.')
    } catch {
      showToast('JSON inválido.')
    }
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand-block">
          <p className="brand">RifaPIX</p>
          <p>
            Conferência de PIX e amortização · logado como <strong>{organizer}</strong>
          </p>
        </div>
        <div className="top-actions">
          <nav className="nav" aria-label="Seções">
            {(
              [
                ['painel', 'Painel'],
                ['rifas', 'Rifas'],
                ['vendas', 'Vendas'],
                ['pix', 'PIX'],
                ['amortizacao', 'Amortização'],
              ] as const
            ).map(([id, label]) => (
              <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)} type="button">
                {label}
              </button>
            ))}
          </nav>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              logout()
              setAuthed(false)
            }}
          >
            Sair
          </button>
        </div>
      </header>

      <section className="hero-metrics" aria-label="Indicadores">
        <article className="metric">
          <span>Esperado nas vendas</span>
          <strong>{brl(metrics.expected)}</strong>
        </article>
        <article className="metric">
          <span>Amortizado</span>
          <strong>{brl(metrics.received)}</strong>
        </article>
        <article className="metric">
          <span>Em aberto</span>
          <strong>{brl(metrics.openSales)}</strong>
        </article>
        <article className="metric">
          <span>PIX sem alocar</span>
          <strong>{brl(metrics.pixOpen)}</strong>
        </article>
      </section>

      {tab === 'painel' && (
        <>
          <section className="panel">
            <div className="panel-head">
              <div>
                <h2>Painel de conferência</h2>
                <p>Compare vendas, extrato PIX e aplique amortizações sugeridas.</p>
              </div>
              <div className="btn-row" style={{ marginTop: 0 }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => {
                    seedDemo()
                    showToast('Dados de demonstração carregados.')
                  }}
                >
                  Carregar demo
                </button>
                <button type="button" className="btn btn-secondary" onClick={downloadBackup}>
                  Baixar backup
                </button>
                <label className="btn btn-secondary file-btn">
                  Restaurar backup
                  <input
                    type="file"
                    accept="application/json,.json"
                    hidden
                    onChange={(e) => onBackupFile(e.target.files?.[0] || null)}
                  />
                </label>
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => {
                    resetAll()
                    showToast('Dados limpos.')
                  }}
                >
                  Limpar tudo
                </button>
              </div>
            </div>
            <div className="grid-2">
              <div>
                <h3>Sugestões de bate-cabelo</h3>
                <p className="hint">Casa nome/valor em aberto entre venda e PIX livre.</p>
                <div className="suggest" style={{ marginTop: '0.75rem' }}>
                  {suggestions.length === 0 && <p className="empty">Nenhuma sugestão automática no momento.</p>}
                  {suggestions.map((s) => {
                    const sale = sales.find((x) => x.id === s.saleId)
                    const pix = pixPayments.find((x) => x.id === s.pixPaymentId)
                    if (!sale || !pix) return null
                    return (
                      <div className="suggest-item" key={`${s.saleId}-${s.pixPaymentId}`}>
                        <div>
                          <strong>{sale.buyerName}</strong> ← {pix.payerName}
                          <div className="hint">
                            {brl(s.amount)} · {s.reason}
                          </div>
                        </div>
                        <button type="button" className="btn btn-primary" onClick={() => applySuggestion(s.saleId, s.pixPaymentId, s.amount)}>
                          Amortizar
                        </button>
                      </div>
                    )
                  })}
                </div>
              </div>
              <div>
                <h3>Resumo por status</h3>
                <div className="table-wrap" style={{ marginTop: '0.75rem' }}>
                  <table>
                    <thead>
                      <tr>
                        <th>Status</th>
                        <th>Vendas</th>
                        <th>Saldo aberto</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(['pendente', 'parcial', 'quitado', 'divergente'] as PaymentStatus[]).map((st) => {
                        const rows = sales.filter((s) => s.status === st)
                        const open = rows.reduce((acc, s) => acc + Math.max(0, s.totalAmount - s.paidAmount), 0)
                        return (
                          <tr key={st}>
                            <td>
                              <span className={`badge ${st}`}>{statusLabel[st]}</span>
                            </td>
                            <td>{rows.length}</td>
                            <td>{brl(open)}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h2>Últimas amortizações</h2>
                <p>Histórico de aplicação de PIX sobre vendas.</p>
              </div>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Quando</th>
                    <th>Comprador</th>
                    <th>Pagador PIX</th>
                    <th>Valor</th>
                    <th>Obs.</th>
                  </tr>
                </thead>
                <tbody>
                  {amortizations.length === 0 && (
                    <tr>
                      <td colSpan={5} className="empty">
                        Ainda sem amortizações.
                      </td>
                    </tr>
                  )}
                  {amortizations.slice(0, 8).map((a) => {
                    const sale = sales.find((s) => s.id === a.saleId)
                    const pix = pixPayments.find((p) => p.id === a.pixPaymentId)
                    return (
                      <tr key={a.id}>
                        <td>{new Date(a.createdAt).toLocaleString('pt-BR')}</td>
                        <td>{sale?.buyerName || '—'}</td>
                        <td>{pix?.payerName || '—'}</td>
                        <td>{brl(a.amount)}</td>
                        <td>{a.note || '—'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      {tab === 'rifas' && (
        <section className="grid-2">
          <form className="panel" onSubmit={onCreateRaffle}>
            <div className="panel-head">
              <div>
                <h2>Nova rifa</h2>
                <p>Defina preço do número e quantidade total.</p>
              </div>
            </div>
            <div className="form-grid">
              <label className="full">
                Nome
                <input name="name" placeholder="Ex.: Rifa da festa" required />
              </label>
              <label>
                Preço do número (R$)
                <input name="ticketPrice" type="number" min="0.01" step="0.01" required />
              </label>
              <label>
                Total de números
                <input name="totalNumbers" type="number" min="1" step="1" required />
              </label>
              <label className="full">
                Prêmio
                <input name="prize" placeholder="O que será sorteado" required />
              </label>
            </div>
            <div className="btn-row">
              <button className="btn btn-primary" type="submit">
                Criar rifa
              </button>
            </div>
          </form>

          <div className="panel">
            <div className="panel-head">
              <div>
                <h2>Rifas ativas</h2>
                <p>{raffles.length} cadastrada(s).</p>
              </div>
            </div>
            {raffles.length === 0 && <p className="empty">Nenhuma rifa ainda.</p>}
            {raffles.map((r) => {
              const sold = sales.filter((s) => s.raffleId === r.id).reduce((acc, s) => acc + s.numbers.length, 0)
              const pct = Math.min(100, Math.round((sold / r.totalNumbers) * 100))
              return (
                <article key={r.id} style={{ marginBottom: '1rem' }}>
                  <strong>{r.name}</strong>
                  <div className="hint">
                    {brl(r.ticketPrice)} / número · {r.totalNumbers} números · {r.prize}
                  </div>
                  <div className="progress" aria-label={`${pct}% vendido`}>
                    <i style={{ width: `${pct}%` }} />
                  </div>
                  <div className="hint" style={{ marginTop: '0.35rem' }}>
                    {sold}/{r.totalNumbers} vendidos ({pct}%)
                  </div>
                  <div className="btn-row">
                    <button type="button" className="btn btn-danger" onClick={() => removeRaffle(r.id)}>
                      Remover
                    </button>
                  </div>
                </article>
              )
            })}
          </div>
        </section>
      )}

      {tab === 'vendas' && (
        <section className="grid-2">
          <form className="panel" onSubmit={onCreateSale}>
            <div className="panel-head">
              <div>
                <h2>Registrar venda</h2>
                <p>Números separados por vírgula. Total calculado pelo preço da rifa.</p>
              </div>
            </div>
            <div className="form-grid">
              <label className="full">
                Rifa
                <select name="raffleId" required defaultValue="">
                  <option value="" disabled>
                    Selecione
                  </option>
                  {raffles.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name} ({brl(r.ticketPrice)})
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Comprador
                <input name="buyerName" required placeholder="Nome completo" />
              </label>
              <label>
                WhatsApp
                <input name="buyerPhone" placeholder="Opcional" />
              </label>
              <label className="full">
                Números
                <input name="numbers" required placeholder="Ex.: 07, 08, 21" />
              </label>
              <label className="full">
                Observações
                <textarea name="notes" placeholder="Combinado de pagamento, etc." />
              </label>
            </div>
            <div className="btn-row">
              <button className="btn btn-primary" type="submit" disabled={!raffles.length}>
                Salvar venda
              </button>
            </div>
          </form>

          <div className="panel">
            <div className="panel-head">
              <div>
                <h2>Vendas</h2>
                <p>Saldo = total − amortizado via PIX.</p>
              </div>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Comprador</th>
                    <th>Números</th>
                    <th>Total</th>
                    <th>Pago</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {sales.length === 0 && (
                    <tr>
                      <td colSpan={6} className="empty">
                        Sem vendas.
                      </td>
                    </tr>
                  )}
                  {sales.map((s) => (
                    <tr key={s.id}>
                      <td>
                        <strong>{s.buyerName}</strong>
                        <div className="hint">{raffleName(s.raffleId)}</div>
                      </td>
                      <td>{formatNumbers(s.numbers)}</td>
                      <td>{brl(s.totalAmount)}</td>
                      <td>{brl(s.paidAmount)}</td>
                      <td>
                        <span className={`badge ${s.status}`}>{statusLabel[s.status]}</span>
                      </td>
                      <td>
                        <button type="button" className="btn btn-ghost" onClick={() => removeSale(s.id)}>
                          Excluir
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      {tab === 'pix' && (
        <>
          <section className="panel" style={{ marginBottom: '1rem' }}>
            <div className="panel-head">
              <div>
                <h2>Importar extrato PIX (CSV)</h2>
                <p>Cabeçalhos reconhecidos: Data, Valor, Nome/Pagador/Descrição, TXID, End-to-end.</p>
              </div>
              <div className="btn-row" style={{ marginTop: 0 }}>
                <button type="button" className="btn btn-secondary" onClick={() => previewCsv(SAMPLE_CSV)}>
                  Ver exemplo
                </button>
                <label className="btn btn-secondary file-btn">
                  Enviar CSV
                  <input type="file" accept=".csv,text/csv,text/plain" hidden onChange={(e) => onFileCsv(e.target.files?.[0] || null)} />
                </label>
              </div>
            </div>
            <label className="full">
              Colar CSV
              <textarea
                value={csvText}
                onChange={(e) => previewCsv(e.target.value)}
                placeholder="Data;Valor;Nome;TXID&#10;11/08/2026;30,00;Maria Souza;ABC"
              />
            </label>
            {importPreview && (
              <div style={{ marginTop: '0.85rem' }}>
                <p className="hint">
                  Prévia: {importPreview.rows.length} crédito(s)
                  {importPreview.errors.length ? ` · ${importPreview.errors.length} linha(s) com erro` : ''}
                </p>
                {importPreview.errors.slice(0, 3).map((err) => (
                  <p className="auth-error" key={err}>
                    {err}
                  </p>
                ))}
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Data</th>
                        <th>Pagador</th>
                        <th>Valor</th>
                        <th>TXID</th>
                      </tr>
                    </thead>
                    <tbody>
                      {importPreview.rows.slice(0, 8).map((r, idx) => (
                        <tr key={`${r.paidAt}-${r.payerName}-${idx}`}>
                          <td>{new Date(r.paidAt).toLocaleDateString('pt-BR')}</td>
                          <td>{r.payerName}</td>
                          <td>{brl(r.amount)}</td>
                          <td>{r.txid || r.endToEndId || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="btn-row">
                  <button type="button" className="btn btn-primary" onClick={confirmImport} disabled={!importPreview.rows.length}>
                    Importar {importPreview.rows.length} PIX
                  </button>
                </div>
              </div>
            )}
          </section>

          <section className="grid-2">
            <form className="panel" onSubmit={onCreatePix}>
              <div className="panel-head">
                <div>
                  <h2>Lançar PIX manual</h2>
                  <p>Para um crédito avulso do extrato.</p>
                </div>
              </div>
              <div className="form-grid">
                <label>
                  Pagador
                  <input name="payerName" required placeholder="Nome no extrato" />
                </label>
                <label>
                  Valor (R$)
                  <input name="amount" type="number" min="0.01" step="0.01" required />
                </label>
                <label>
                  Data
                  <input name="paidAt" type="date" required defaultValue={todayInput()} />
                </label>
                <label>
                  TXID
                  <input name="txid" placeholder="Opcional" />
                </label>
                <label className="full">
                  End-to-end
                  <input name="endToEndId" placeholder="E..." />
                </label>
                <label className="full">
                  Observações
                  <textarea name="notes" />
                </label>
              </div>
              <div className="btn-row">
                <button className="btn btn-primary" type="submit">
                  Incluir PIX
                </button>
              </div>
            </form>

            <div className="panel">
              <div className="panel-head">
                <div>
                  <h2>Extrato PIX</h2>
                  <p>Livre = ainda não amortizado em vendas.</p>
                </div>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Pagador</th>
                      <th>Data</th>
                      <th>Valor</th>
                      <th>Alocado</th>
                      <th>Situação</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {pixPayments.length === 0 && (
                      <tr>
                        <td colSpan={6} className="empty">
                          Sem PIX lançados.
                        </td>
                      </tr>
                    )}
                    {pixPayments.map((p) => {
                      const open = p.amount - p.allocatedAmount
                      const situacao = open <= 0.009 ? 'alocado' : p.allocatedAmount > 0 ? 'parcial' : 'livre'
                      return (
                        <tr key={p.id}>
                          <td>
                            <strong>{p.payerName}</strong>
                            <div className="hint">{p.txid || p.endToEndId || '—'}</div>
                          </td>
                          <td>{new Date(p.paidAt).toLocaleDateString('pt-BR')}</td>
                          <td>{brl(p.amount)}</td>
                          <td>{brl(p.allocatedAmount)}</td>
                          <td>
                            <span className={`badge ${situacao === 'livre' ? 'livre' : situacao === 'alocado' ? 'alocado' : 'parcial'}`}>
                              {situacao === 'livre' ? 'Livre' : situacao === 'alocado' ? 'Alocado' : 'Parcial'}
                            </span>
                          </td>
                          <td>
                            <button type="button" className="btn btn-ghost" onClick={() => removePix(p.id)}>
                              Excluir
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        </>
      )}

      {tab === 'amortizacao' && (
        <section className="grid-2">
          <form className="panel" onSubmit={onAmortize}>
            <div className="panel-head">
              <div>
                <h2>Amortizar venda com PIX</h2>
                <p>Aplique parte ou o total de um PIX livre sobre o saldo da venda.</p>
              </div>
            </div>
            <div className="form-grid">
              <label className="full">
                Venda em aberto
                <select name="saleId" required defaultValue="">
                  <option value="" disabled>
                    Selecione
                  </option>
                  {sales
                    .filter((s) => s.paidAmount < s.totalAmount - 0.009)
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.buyerName} · aberto {brl(s.totalAmount - s.paidAmount)} · nº {formatNumbers(s.numbers)}
                      </option>
                    ))}
                </select>
              </label>
              <label className="full">
                PIX disponível
                <select name="pixPaymentId" required defaultValue="">
                  <option value="" disabled>
                    Selecione
                  </option>
                  {pixPayments
                    .filter((p) => p.allocatedAmount < p.amount - 0.009)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.payerName} · livre {brl(p.amount - p.allocatedAmount)} · {new Date(p.paidAt).toLocaleDateString('pt-BR')}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                Valor a amortizar
                <input name="amount" type="number" min="0.01" step="0.01" required />
              </label>
              <label>
                Nota
                <input name="note" placeholder="Ex.: 1ª parcela" />
              </label>
            </div>
            <div className="btn-row">
              <button className="btn btn-primary" type="submit">
                Aplicar amortização
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => setTab('painel')}>
                Ver sugestões
              </button>
            </div>
          </form>

          <div className="panel">
            <div className="panel-head">
              <div>
                <h2>Livro de amortizações</h2>
                <p>{amortizations.length} lançamento(s).</p>
              </div>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Data</th>
                    <th>Venda</th>
                    <th>PIX</th>
                    <th>Valor</th>
                  </tr>
                </thead>
                <tbody>
                  {amortizations.length === 0 && (
                    <tr>
                      <td colSpan={4} className="empty">
                        Nenhuma amortização registrada.
                      </td>
                    </tr>
                  )}
                  {amortizations.map((a) => {
                    const sale = sales.find((s) => s.id === a.saleId)
                    const pix = pixPayments.find((p) => p.id === a.pixPaymentId)
                    return (
                      <tr key={a.id}>
                        <td>{new Date(a.createdAt).toLocaleString('pt-BR')}</td>
                        <td>{sale?.buyerName || '—'}</td>
                        <td>{pix?.payerName || '—'}</td>
                        <td>{brl(a.amount)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
