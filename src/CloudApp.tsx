import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { parsePixCsv, SAMPLE_CSV } from './csvImport'
import * as api from './lib/api'
import type { DbAmortization, DbPixCharge, DbPixPayment, DbRaffle, DbSale } from './lib/supabase'
import { useAuth } from './lib/useAuth'
import { brl, formatNumbers } from './store'
import { previewTxidMatches } from './txidMatch'
import type { PaymentStatus } from './types'

type Tab = 'painel' | 'rifas' | 'vendas' | 'pix' | 'amortizacao' | 'cobrancas'

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
    if (!Number.isInteger(n) || n < 1 || n > max) return { ok: false, error: `Número inválido: ${part}` }
    numbers.push(n)
  }
  const unique = [...new Set(numbers)]
  if (unique.length !== numbers.length) return { ok: false, error: 'Há números repetidos na venda.' }
  return { ok: true, numbers: unique }
}

export default function CloudApp() {
  const auth = useAuth()
  const userId = auth.user?.id || ''
  const [tab, setTab] = useState<Tab>('painel')
  const [toast, setToast] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [raffles, setRaffles] = useState<DbRaffle[]>([])
  const [sales, setSales] = useState<DbSale[]>([])
  const [pixPayments, setPixPayments] = useState<DbPixPayment[]>([])
  const [amortizations, setAmortizations] = useState<DbAmortization[]>([])
  const [pixCharges, setPixCharges] = useState<DbPixCharge[]>([])
  const [csvText, setCsvText] = useState('')
  const [importPreview, setImportPreview] = useState<ReturnType<typeof parsePixCsv> | null>(null)
  const [manualTxid, setManualTxid] = useState('')

  const showToast = (msg: string) => {
    setToast(msg)
    window.setTimeout(() => setToast(null), 2800)
  }

  const refresh = useCallback(async () => {
    if (!userId) return
    const data = await api.fetchAllData(userId)
    setRaffles(data.raffles)
    setSales(data.sales)
    setPixPayments(data.pixPayments)
    setAmortizations(data.amortizations)
    setPixCharges(data.pixCharges)
  }, [userId])

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        setLoading(true)
        await refresh()
      } catch (err) {
        if (alive) showToast(err instanceof Error ? err.message : 'Falha ao carregar dados')
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [refresh])

  const metrics = useMemo(() => {
    const expected = sales.reduce((acc, s) => acc + Number(s.total_amount), 0)
    const received = sales.reduce((acc, s) => acc + Number(s.paid_amount), 0)
    const pixOpen = pixPayments.reduce((acc, p) => acc + Math.max(0, Number(p.amount) - Number(p.allocated_amount)), 0)
    return { expected, received, openSales: expected - received, pixOpen }
  }, [sales, pixPayments])

  const takenNumbers = useMemo(() => {
    const map = new Map<string, Set<number>>()
    for (const sale of sales) {
      const set = map.get(sale.raffle_id) ?? new Set<number>()
      sale.numbers.forEach((n) => set.add(n))
      map.set(sale.raffle_id, set)
    }
    return map
  }, [sales])

  const raffleName = (id: string) => raffles.find((r) => r.id === id)?.name || '—'
  const saleName = (id: string) => sales.find((s) => s.id === id)?.buyer_name || '—'

  const onCreateRaffle = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    try {
      await api.createRaffle(userId, {
        name: String(fd.get('name') || '').trim(),
        prize: String(fd.get('prize') || '').trim(),
        ticketPrice: Number(fd.get('ticketPrice')),
        totalNumbers: Number(fd.get('totalNumbers')),
      })
      e.currentTarget.reset()
      await refresh()
      showToast('Rifa criada no banco.')
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Erro ao criar rifa')
    }
  }

  const onCreateSale = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    const raffleId = String(fd.get('raffleId') || '')
    const raffle = raffles.find((r) => r.id === raffleId)
    if (!raffle) return showToast('Selecione uma rifa.')
    const parsed = parseNumbers(String(fd.get('numbers') || ''), raffle.total_numbers)
    if (!parsed.ok) return showToast(parsed.error)
    const taken = takenNumbers.get(raffleId) ?? new Set()
    const clash = parsed.numbers.find((n) => taken.has(n))
    if (clash !== undefined) return showToast(`Número ${String(clash).padStart(2, '0')} já vendido.`)
    try {
      await api.createSale(userId, {
        raffleId,
        buyerName: String(fd.get('buyerName') || ''),
        buyerPhone: String(fd.get('buyerPhone') || ''),
        numbers: parsed.numbers,
        totalAmount: parsed.numbers.length * Number(raffle.ticket_price),
        notes: String(fd.get('notes') || ''),
      })
      e.currentTarget.reset()
      await refresh()
      showToast('Venda salva no banco.')
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Erro ao salvar venda')
    }
  }

  const onCreatePix = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    try {
      await api.createPix(userId, {
        amount: Number(fd.get('amount')),
        payerName: String(fd.get('payerName') || ''),
        paidAt: String(fd.get('paidAt') || ''),
        txid: String(fd.get('txid') || ''),
        endToEndId: String(fd.get('endToEndId') || ''),
        notes: String(fd.get('notes') || ''),
      })
      e.currentTarget.reset()
      await refresh()
      showToast('PIX lançado.')
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Erro ao lançar PIX')
    }
  }

  const onAmortize = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    try {
      await api.amortize(userId, String(fd.get('saleId')), String(fd.get('pixPaymentId')), Number(fd.get('amount')), String(fd.get('note') || ''))
      e.currentTarget.reset()
      await refresh()
      showToast('Amortização aplicada.')
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Erro na amortização')
    }
  }

  const previewCsv = (text: string) => {
    setCsvText(text)
    setImportPreview(parsePixCsv(text))
  }

  const confirmImport = async () => {
    if (!importPreview?.rows.length) return showToast('Nada para importar.')
    try {
      const result = await api.importCsvAndSettleByTxid(userId, importPreview.rows)
      setCsvText('')
      setImportPreview(null)
      await refresh()
      showToast(`Importados ${result.imported}. Baixas por TXID: ${result.settled}. Sem match: ${result.unmatchedWithTxid}.`)
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Erro na importação')
    }
  }

  const txidPreview = useMemo(() => {
    if (!importPreview?.rows.length) return []
    return previewTxidMatches(
      importPreview.rows,
      pixCharges.map((c) => ({
        id: c.id,
        saleId: c.sale_id,
        txid: c.txid,
        amount: Number(c.amount),
        status: c.status,
      })),
    )
  }, [importPreview, pixCharges])

  const generateCharge = async (saleId: string) => {
    try {
      const charge = await api.createPixCharge(saleId)
      await refresh()
      setTab('cobrancas')
      showToast(`Cobrança gerada: ${charge.txid}`)
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Erro ao gerar cobrança')
    }
  }

  const simulatePay = async (chargeId: string) => {
    try {
      await api.simulatePixPayment(chargeId)
      await refresh()
      showToast('Pagamento simulado: baixa automática aplicada.')
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Erro ao simular')
    }
  }

  const organizer = auth.user?.user_metadata?.organizer_name || auth.user?.email || 'Organizador'

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand-block">
          <p className="brand">RifaPIX</p>
          <p>
            Nuvem + Postgres · <strong>{organizer}</strong>
            {loading ? ' · sincronizando…' : ''}
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
                ['cobrancas', 'Cobranças'],
                ['amortizacao', 'Amortização'],
              ] as const
            ).map(([id, label]) => (
              <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)} type="button">
                {label}
              </button>
            ))}
          </nav>
          <button type="button" className="btn btn-secondary" onClick={() => auth.signOut()}>
            Sair
          </button>
        </div>
      </header>

      <section className="hero-metrics">
        <article className="metric">
          <span>Esperado</span>
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
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Baixa automática</h2>
              <p>
                Gere uma cobrança PIX na venda. Quando o PSP/banco enviar o webhook (ou use “Simular pagamento”), a amortização roda sozinha.
              </p>
            </div>
            <button type="button" className="btn btn-secondary" onClick={() => refresh().then(() => showToast('Dados atualizados.'))}>
              Atualizar
            </button>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Comprador</th>
                  <th>Aberto</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {sales.filter((s) => Number(s.paid_amount) < Number(s.total_amount) - 0.009).length === 0 && (
                  <tr>
                    <td colSpan={4} className="empty">
                      Nenhuma venda em aberto.
                    </td>
                  </tr>
                )}
                {sales
                  .filter((s) => Number(s.paid_amount) < Number(s.total_amount) - 0.009)
                  .map((s) => (
                    <tr key={s.id}>
                      <td>
                        <strong>{s.buyer_name}</strong>
                        <div className="hint">{raffleName(s.raffle_id)} · nº {formatNumbers(s.numbers)}</div>
                      </td>
                      <td>{brl(Number(s.total_amount) - Number(s.paid_amount))}</td>
                      <td>
                        <span className={`badge ${s.status}`}>{statusLabel[s.status]}</span>
                      </td>
                      <td>
                        <button type="button" className="btn btn-primary" onClick={() => generateCharge(s.id)}>
                          Gerar PIX
                        </button>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {tab === 'rifas' && (
        <section className="grid-2">
          <form className="panel" onSubmit={onCreateRaffle}>
            <div className="panel-head">
              <div>
                <h2>Nova rifa</h2>
                <p>Salva no Postgres.</p>
              </div>
            </div>
            <div className="form-grid">
              <label className="full">
                Nome
                <input name="name" required />
              </label>
              <label>
                Preço (R$)
                <input name="ticketPrice" type="number" min="0.01" step="0.01" required />
              </label>
              <label>
                Total números
                <input name="totalNumbers" type="number" min="1" step="1" required />
              </label>
              <label className="full">
                Prêmio
                <input name="prize" required />
              </label>
            </div>
            <div className="btn-row">
              <button className="btn btn-primary" type="submit">
                Criar
              </button>
            </div>
          </form>
          <div className="panel">
            <div className="panel-head">
              <div>
                <h2>Rifas</h2>
                <p>{raffles.length} no banco.</p>
              </div>
            </div>
            {raffles.map((r) => (
              <article key={r.id} style={{ marginBottom: '0.85rem' }}>
                <strong>{r.name}</strong>
                <div className="hint">
                  {brl(Number(r.ticket_price))} · {r.total_numbers} números · {r.prize}
                </div>
                <div className="btn-row">
                  <button
                    type="button"
                    className="btn btn-danger"
                    onClick={async () => {
                      await api.deleteRaffle(r.id)
                      await refresh()
                    }}
                  >
                    Remover
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      {tab === 'vendas' && (
        <section className="grid-2">
          <form className="panel" onSubmit={onCreateSale}>
            <div className="panel-head">
              <div>
                <h2>Registrar venda</h2>
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
                      {r.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Comprador
                <input name="buyerName" required />
              </label>
              <label>
                WhatsApp
                <input name="buyerPhone" />
              </label>
              <label className="full">
                Números
                <input name="numbers" required placeholder="7, 8, 9" />
              </label>
              <label className="full">
                Obs.
                <textarea name="notes" />
              </label>
            </div>
            <div className="btn-row">
              <button className="btn btn-primary" type="submit">
                Salvar
              </button>
            </div>
          </form>
          <div className="panel">
            <div className="panel-head">
              <div>
                <h2>Vendas</h2>
              </div>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Comprador</th>
                    <th>Números</th>
                    <th>Pago</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {sales.map((s) => (
                    <tr key={s.id}>
                      <td>
                        <strong>{s.buyer_name}</strong>
                        <div className="hint">{raffleName(s.raffle_id)}</div>
                      </td>
                      <td>{formatNumbers(s.numbers)}</td>
                      <td>
                        {brl(Number(s.paid_amount))} / {brl(Number(s.total_amount))}
                      </td>
                      <td>
                        <span className={`badge ${s.status}`}>{statusLabel[s.status]}</span>
                      </td>
                      <td>
                        <button type="button" className="btn btn-ghost" onClick={() => generateCharge(s.id)}>
                          PIX
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
                <h2>Importar CSV com baixa por TXID</h2>
                <p>Linhas com o mesmo TXID de uma cobrança pendente são amortizadas automaticamente.</p>
              </div>
              <button type="button" className="btn btn-secondary" onClick={() => previewCsv(SAMPLE_CSV)}>
                Exemplo
              </button>
            </div>
            <label>
              CSV
              <textarea value={csvText} onChange={(e) => previewCsv(e.target.value)} />
            </label>
            {importPreview && (
              <>
                <p className="hint" style={{ marginTop: '0.75rem' }}>
                  {importPreview.rows.length} crédito(s) · {txidPreview.length} match(es) por TXID
                </p>
                {txidPreview.length > 0 && (
                  <div className="suggest" style={{ margin: '0.75rem 0' }}>
                    {txidPreview.map((m) => (
                      <div className="suggest-item" key={`${m.chargeId}-${m.rowIndex}`}>
                        <div>
                          <strong>{m.txid}</strong>
                          <div className="hint">
                            {saleName(m.saleId)} ← {m.row.payerName} · {brl(m.settleAmount)}
                          </div>
                        </div>
                        <span className="badge quitado">Alta confiança</span>
                      </div>
                    ))}
                  </div>
                )}
                <div className="btn-row">
                  <button type="button" className="btn btn-primary" onClick={confirmImport}>
                    Importar e baixar por TXID ({txidPreview.length})
                  </button>
                </div>
              </>
            )}
          </section>
          <section className="grid-2">
            <form className="panel" onSubmit={onCreatePix}>
              <div className="panel-head">
                <div>
                  <h2>PIX manual</h2>
                </div>
              </div>
              <div className="form-grid">
                <label>
                  Pagador
                  <input name="payerName" required />
                </label>
                <label>
                  Valor
                  <input name="amount" type="number" step="0.01" min="0.01" required />
                </label>
                <label>
                  Data
                  <input name="paidAt" type="date" defaultValue={todayInput()} required />
                </label>
                <label>
                  TXID
                  <input name="txid" />
                </label>
              </div>
              <div className="btn-row">
                <button className="btn btn-primary" type="submit">
                  Incluir
                </button>
              </div>
            </form>
            <div className="panel">
              <div className="panel-head">
                <div>
                  <h2>Extrato</h2>
                </div>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Pagador</th>
                      <th>Valor</th>
                      <th>Alocado</th>
                      <th>Origem</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pixPayments.map((p) => (
                      <tr key={p.id}>
                        <td>
                          <strong>{p.payer_name}</strong>
                          <div className="hint">{p.txid || '—'}</div>
                        </td>
                        <td>{brl(Number(p.amount))}</td>
                        <td>{brl(Number(p.allocated_amount))}</td>
                        <td>{p.provider}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        </>
      )}

      {tab === 'cobrancas' && (
        <section className="grid-2">
          <form
            className="panel"
            onSubmit={async (e) => {
              e.preventDefault()
              const fd = new FormData(e.currentTarget)
              try {
                const charge = await api.attachTxidToSale(
                  userId,
                  String(fd.get('saleId')),
                  String(fd.get('txid')),
                  Number(fd.get('amount') || 0) || undefined,
                )
                e.currentTarget.reset()
                setManualTxid('')
                await refresh()
                showToast(`TXID vinculado: ${charge.txid}`)
              } catch (err) {
                showToast(err instanceof Error ? err.message : 'Erro ao vincular TXID')
              }
            }}
          >
            <div className="panel-head">
              <div>
                <h2>Vincular TXID manual</h2>
                <p>Se você já gerou a cobrança no banco, cole o TXID aqui para o CSV baixar certo.</p>
              </div>
            </div>
            <div className="form-grid">
              <label className="full">
                Venda
                <select name="saleId" required defaultValue="">
                  <option value="" disabled>
                    Selecione
                  </option>
                  {sales
                    .filter((s) => Number(s.paid_amount) < Number(s.total_amount) - 0.009)
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.buyer_name} · {brl(Number(s.total_amount) - Number(s.paid_amount))}
                      </option>
                    ))}
                </select>
              </label>
              <label className="full">
                TXID
                <input name="txid" required value={manualTxid} onChange={(e) => setManualTxid(e.target.value)} />
              </label>
              <label>
                Valor (opcional)
                <input name="amount" type="number" step="0.01" min="0.01" />
              </label>
            </div>
            <div className="btn-row">
              <button className="btn btn-primary" type="submit">
                Vincular
              </button>
            </div>
          </form>

          <div className="panel">
            <div className="panel-head">
              <div>
                <h2>Cobranças PIX</h2>
                <p>Webhook ou CSV com o mesmo TXID fazem a baixa automática.</p>
              </div>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Venda</th>
                    <th>TXID</th>
                    <th>Valor</th>
                    <th>Status</th>
                    <th>Copia e cola</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {pixCharges.length === 0 && (
                    <tr>
                      <td colSpan={6} className="empty">
                        Nenhuma cobrança. Gere a partir do painel ou vendas.
                      </td>
                    </tr>
                  )}
                  {pixCharges.map((c) => (
                    <tr key={c.id}>
                      <td>{saleName(c.sale_id)}</td>
                      <td>
                        <code>{c.txid}</code>
                      </td>
                      <td>{brl(Number(c.amount))}</td>
                      <td>
                        <span className={`badge ${c.status === 'paid' ? 'quitado' : 'pendente'}`}>{c.status}</span>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn btn-ghost"
                          onClick={async () => {
                            if (!c.copy_paste) return
                            await navigator.clipboard.writeText(c.copy_paste)
                            showToast('PIX copia-e-cola copiado.')
                          }}
                        >
                          Copiar
                        </button>
                      </td>
                      <td>
                        {c.status === 'pending' && (
                          <button type="button" className="btn btn-primary" onClick={() => simulatePay(c.id)}>
                            Simular pagamento
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      {tab === 'amortizacao' && (
        <section className="grid-2">
          <form className="panel" onSubmit={onAmortize}>
            <div className="panel-head">
              <div>
                <h2>Amortizar manual</h2>
              </div>
            </div>
            <div className="form-grid">
              <label className="full">
                Venda
                <select name="saleId" required defaultValue="">
                  <option value="" disabled>
                    Selecione
                  </option>
                  {sales
                    .filter((s) => Number(s.paid_amount) < Number(s.total_amount) - 0.009)
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.buyer_name} · {brl(Number(s.total_amount) - Number(s.paid_amount))}
                      </option>
                    ))}
                </select>
              </label>
              <label className="full">
                PIX
                <select name="pixPaymentId" required defaultValue="">
                  <option value="" disabled>
                    Selecione
                  </option>
                  {pixPayments
                    .filter((p) => Number(p.allocated_amount) < Number(p.amount) - 0.009)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.payer_name} · {brl(Number(p.amount) - Number(p.allocated_amount))}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                Valor
                <input name="amount" type="number" step="0.01" min="0.01" required />
              </label>
              <label>
                Nota
                <input name="note" />
              </label>
            </div>
            <div className="btn-row">
              <button className="btn btn-primary" type="submit">
                Aplicar
              </button>
            </div>
          </form>
          <div className="panel">
            <div className="panel-head">
              <div>
                <h2>Livro</h2>
              </div>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Quando</th>
                    <th>Venda</th>
                    <th>Valor</th>
                    <th>Origem</th>
                  </tr>
                </thead>
                <tbody>
                  {amortizations.map((a) => (
                    <tr key={a.id}>
                      <td>{new Date(a.created_at).toLocaleString('pt-BR')}</td>
                      <td>{saleName(a.sale_id)}</td>
                      <td>{brl(Number(a.amount))}</td>
                      <td>{a.source}</td>
                    </tr>
                  ))}
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
