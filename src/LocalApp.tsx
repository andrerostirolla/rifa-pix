import { useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { getAuthRecord, getSession, logout } from './auth'
import { parsePixCsv, SAMPLE_CSV } from './csvImport'
import { NumberGrid } from './NumberGrid'
import { brl, formatNumbers, useStore } from './store'
import { previewTxidMatches } from './txidMatch'
import type { PaymentMethod, PaymentStatus, PixDestination } from './types'

type AdminTab = 'painel' | 'equipe' | 'eventos' | 'vendas' | 'pix' | 'txid' | 'amortizacao' | 'relatorios'
type MemberTab = 'numeros' | 'vendas'

const statusLabel: Record<PaymentStatus, string> = {
  pendente: 'Pendente',
  parcial: 'Parcial',
  quitado: 'Quitado',
  divergente: 'Divergente',
}

export default function LocalApp() {
  const session = getSession()
  const isAdmin = session?.role === 'admin'
  const memberId = session?.memberId || ''

  const [adminTab, setAdminTab] = useState<AdminTab>('painel')
  const [memberTab, setMemberTab] = useState<MemberTab>('numeros')
  const [toast, setToast] = useState<string | null>(null)
  const [selectedNumbers, setSelectedNumbers] = useState<number[]>([])
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('dinheiro')
  const [pixDestination, setPixDestination] = useState<PixDestination>('entidade')
  const [saleRaffleId, setSaleRaffleId] = useState('')
  const [csvText, setCsvText] = useState('')
  const [importPreview, setImportPreview] = useState<ReturnType<typeof parsePixCsv> | null>(null)

  const raffles = useStore((s) => s.raffles)
  const members = useStore((s) => s.members)
  const numberRanges = useStore((s) => s.numberRanges)
  const sales = useStore((s) => s.sales)
  const pixPayments = useStore((s) => s.pixPayments)
  const amortizations = useStore((s) => s.amortizations)
  const pixCharges = useStore((s) => s.pixCharges)
  const memberSettlements = useStore((s) => s.memberSettlements)
  const addRaffle = useStore((s) => s.addRaffle)
  const removeRaffle = useStore((s) => s.removeRaffle)
  const addMember = useStore((s) => s.addMember)
  const removeMember = useStore((s) => s.removeMember)
  const assignRange = useStore((s) => s.assignRange)
  const removeRange = useStore((s) => s.removeRange)
  const memberNumbers = useStore((s) => s.memberNumbers)
  const soldNumbers = useStore((s) => s.soldNumbers)
  const addSale = useStore((s) => s.addSale)
  const removeSale = useStore((s) => s.removeSale)
  const importCsvAndSettleByTxid = useStore((s) => s.importCsvAndSettleByTxid)
  const amortize = useStore((s) => s.amortize)
  const autoMatchSuggestions = useStore((s) => s.autoMatchSuggestions)
  const addMemberSettlement = useStore((s) => s.addMemberSettlement)
  const seedDemo = useStore((s) => s.seedDemo)
  const resetAll = useStore((s) => s.resetAll)

  const showToast = (msg: string) => {
    setToast(msg)
    window.setTimeout(() => setToast(null), 2800)
  }

  const activeRaffles = raffles.filter((r) => r.active)
  const currentRaffleId = saleRaffleId || activeRaffles[0]?.id || ''
  const myNumbers = memberId && currentRaffleId ? memberNumbers(memberId, currentRaffleId) : []
  const sold = currentRaffleId ? soldNumbers(currentRaffleId) : new Set<number>()

  const visibleSales = useMemo(() => {
    if (isAdmin) return sales
    return sales.filter((s) => s.memberId === memberId)
  }, [isAdmin, sales, memberId])

  const suggestions = useMemo(() => autoMatchSuggestions(), [sales, pixPayments, pixCharges, amortizations, autoMatchSuggestions])

  const txidPreview = useMemo(() => {
    if (!importPreview?.rows.length) return []
    return previewTxidMatches(
      importPreview.rows,
      pixCharges.map((c) => ({ id: c.id, saleId: c.saleId, txid: c.txid, amount: c.amount, status: c.status })),
    )
  }, [importPreview, pixCharges])

  const reports = useMemo(() => {
    return members.map((m) => {
      const mSales = sales.filter((s) => s.memberId === m.id)
      const soldCount = mSales.reduce((acc, s) => acc + s.numbers.length, 0)
      const expected = mSales.reduce((acc, s) => acc + s.totalAmount, 0)
      const received = mSales.reduce((acc, s) => acc + s.paidAmount, 0)
      const cash = mSales.filter((s) => s.paymentMethod === 'dinheiro').reduce((acc, s) => acc + s.paidAmount, 0)
      const pixEntidade = mSales
        .filter((s) => s.paymentMethod === 'pix' && s.pixDestination === 'entidade')
        .reduce((acc, s) => acc + s.paidAmount, 0)
      const pixVendedor = mSales
        .filter((s) => s.paymentMethod === 'pix' && s.pixDestination === 'vendedor')
        .reduce((acc, s) => acc + s.paidAmount, 0)
      const settledCash = memberSettlements.filter((x) => x.memberId === m.id && x.kind === 'dinheiro').reduce((a, x) => a + x.amount, 0)
      const settledPix = memberSettlements
        .filter((x) => x.memberId === m.id && x.kind === 'pix_vendedor')
        .reduce((a, x) => a + x.amount, 0)
      return {
        member: m,
        soldCount,
        expected,
        received,
        cash,
        pixEntidade,
        pixVendedor,
        cashOpen: Math.max(0, cash - settledCash),
        pixVendedorOpen: Math.max(0, pixVendedor - settledPix),
      }
    })
  }, [members, sales, memberSettlements])

  const who = isAdmin ? getAuthRecord()?.organizerName || 'ADM' : session?.memberName || 'Membro'

  const toggleNumber = (n: number) => {
    setSelectedNumbers((prev) => (prev.includes(n) ? prev.filter((x) => x !== n) : [...prev, n].sort((a, b) => a - b)))
  }

  const onCreateSale = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!memberId && !isAdmin) return
    const fd = new FormData(e.currentTarget)
    const sellerId = isAdmin ? String(fd.get('memberId') || '') : memberId
    const raffleId = String(fd.get('raffleId') || currentRaffleId)
    const result = addSale({
      raffleId,
      memberId: sellerId,
      buyerName: String(fd.get('buyerName') || ''),
      buyerPhone: String(fd.get('buyerPhone') || ''),
      numbers: selectedNumbers,
      paymentMethod,
      pixDestination: paymentMethod === 'pix' ? pixDestination : undefined,
      notes: String(fd.get('notes') || ''),
      proofTxid: String(fd.get('proofTxid') || ''),
      receivedNow: paymentMethod === 'dinheiro' || String(fd.get('receivedNow') || '') === 'sim',
    })
    if (!result.ok) return showToast(result.error)
    e.currentTarget.reset()
    setSelectedNumbers([])
    setPaymentMethod('dinheiro')
    showToast('Venda registrada.')
  }

  if (!session) {
    return (
      <div className="auth-shell">
        <div className="panel auth-card">
          <p>Sessão expirada.</p>
          <button className="btn btn-primary" type="button" onClick={() => window.location.reload()}>
            Entrar de novo
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand-block">
          <p className="brand">RifaPIX</p>
          <p>
            {isAdmin ? 'Administrador' : 'Membro'} · <strong>{who}</strong>
          </p>
        </div>
        <div className="top-actions">
          <nav className="nav">
            {isAdmin
              ? (
                  [
                    ['painel', 'Painel'],
                    ['equipe', 'Equipe'],
                    ['eventos', 'Eventos'],
                    ['vendas', 'Vendas'],
                    ['pix', 'PIX/CSV'],
                    ['txid', 'TXID'],
                    ['amortizacao', 'Baixas'],
                    ['relatorios', 'Relatórios'],
                  ] as const
                ).map(([id, label]) => (
                  <button key={id} type="button" className={adminTab === id ? 'active' : ''} onClick={() => setAdminTab(id)}>
                    {label}
                  </button>
                ))
              : (
                  [
                    ['numeros', 'Meus números'],
                    ['vendas', 'Minhas vendas'],
                  ] as const
                ).map(([id, label]) => (
                  <button key={id} type="button" className={memberTab === id ? 'active' : ''} onClick={() => setMemberTab(id)}>
                    {label}
                  </button>
                ))}
          </nav>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              logout()
              window.location.reload()
            }}
          >
            Sair
          </button>
        </div>
      </header>

      {/* MEMBER VIEW */}
      {!isAdmin && memberTab === 'numeros' && (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Meus números</h2>
              <p>
                Verde = disponível · Vermelho = vendido. Selecione os verdes para vender.
              </p>
            </div>
            <label>
              Evento/rifa
              <select
                value={currentRaffleId}
                onChange={(e) => {
                  setSaleRaffleId(e.target.value)
                  setSelectedNumbers([])
                }}
              >
                {activeRaffles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.eventName} — {r.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <NumberGrid
            numbers={myNumbers}
            sold={sold}
            selected={new Set(selectedNumbers)}
            onToggle={toggleNumber}
          />
          <p className="hint" style={{ marginTop: '0.75rem' }}>
            Selecionados: {selectedNumbers.length ? formatNumbers(selectedNumbers) : 'nenhum'}
          </p>
        </section>
      )}

      {!isAdmin && memberTab === 'vendas' && (
        <section className="grid-2">
          <form className="panel" onSubmit={onCreateSale}>
            <div className="panel-head">
              <div>
                <h2>Lançar venda</h2>
                <p>Só números seus. TXID e observação são opcionais.</p>
              </div>
            </div>
            <div className="form-grid">
              <label className="full">
                Evento/rifa
                <select
                  name="raffleId"
                  required
                  value={currentRaffleId}
                  onChange={(e) => {
                    setSaleRaffleId(e.target.value)
                    setSelectedNumbers([])
                  }}
                >
                  {activeRaffles.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.eventName} — {r.name} ({brl(r.ticketPrice)})
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
                Forma de recebimento
                <select
                  value={paymentMethod}
                  onChange={(e) => setPaymentMethod(e.target.value as PaymentMethod)}
                  required
                >
                  <option value="dinheiro">Dinheiro</option>
                  <option value="pix">PIX</option>
                </select>
              </label>
              {paymentMethod === 'pix' && (
                <label className="full">
                  PIX caiu em qual conta?
                  <select value={pixDestination} onChange={(e) => setPixDestination(e.target.value as PixDestination)} required>
                    <option value="entidade">Conta da entidade</option>
                    <option value="vendedor">Minha conta (vendedor)</option>
                  </select>
                </label>
              )}
              {paymentMethod === 'pix' && (
                <label className="full">
                  Já recebeu este PIX?
                  <select name="receivedNow" defaultValue="nao">
                    <option value="nao">Ainda não (fica pendente)</option>
                    <option value="sim">Sim, já caiu</option>
                  </select>
                </label>
              )}
              <label className="full">
                TXID / End-to-end (opcional)
                <input name="proofTxid" placeholder="Do comprovante, se tiver" />
              </label>
              <label className="full">
                Observações (opcional)
                <textarea name="notes" />
              </label>
            </div>
            <NumberGrid numbers={myNumbers} sold={sold} selected={new Set(selectedNumbers)} onToggle={toggleNumber} />
            <div className="btn-row">
              <button className="btn btn-primary" type="submit" disabled={!selectedNumbers.length}>
                Salvar venda ({selectedNumbers.length} nº · {brl(selectedNumbers.length * (activeRaffles.find((r) => r.id === currentRaffleId)?.ticketPrice || 0))})
              </button>
            </div>
          </form>
          <div className="panel">
            <div className="panel-head">
              <div>
                <h2>Minhas vendas</h2>
              </div>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Comprador</th>
                    <th>Números</th>
                    <th>Recebimento</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleSales.map((s) => (
                    <tr key={s.id}>
                      <td>{s.buyerName}</td>
                      <td>{formatNumbers(s.numbers)}</td>
                      <td>
                        {s.paymentMethod === 'dinheiro' ? 'Dinheiro' : `PIX (${s.pixDestination === 'entidade' ? 'entidade' : 'vendedor'})`}
                        <div className="hint">
                          {brl(s.paidAmount)} / {brl(s.totalAmount)}
                        </div>
                      </td>
                      <td>
                        <span className={`badge ${s.status}`}>{statusLabel[s.status]}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      {/* ADMIN */}
      {isAdmin && adminTab === 'painel' && (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Painel ADM</h2>
              <p>Cadastre equipe e faixas, depois cada membro vende só os números dele.</p>
            </div>
            <div className="btn-row" style={{ marginTop: 0 }}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  seedDemo()
                  showToast('Demo: Carlos PIN 1234 (1-50), Fernanda PIN 5678 (51-100).')
                }}
              >
                Carregar demo
              </button>
              <button type="button" className="btn btn-danger" onClick={() => { resetAll(); showToast('Dados limpos.') }}>
                Limpar
              </button>
            </div>
          </div>
          <div className="hero-metrics">
            <article className="metric">
              <span>Membros</span>
              <strong>{members.length}</strong>
            </article>
            <article className="metric">
              <span>Vendas</span>
              <strong>{sales.length}</strong>
            </article>
            <article className="metric">
              <span>Esperado</span>
              <strong>{brl(sales.reduce((a, s) => a + s.totalAmount, 0))}</strong>
            </article>
            <article className="metric">
              <span>Recebido</span>
              <strong>{brl(sales.reduce((a, s) => a + s.paidAmount, 0))}</strong>
            </article>
          </div>
          <h3>Sugestões TXID</h3>
          {suggestions.length === 0 && <p className="empty">Nenhuma sugestão agora.</p>}
          {suggestions.map((s) => {
            const sale = sales.find((x) => x.id === s.saleId)
            const pix = pixPayments.find((x) => x.id === s.pixPaymentId)
            return (
              <div className="suggest-item" key={`${s.saleId}-${s.pixPaymentId}`}>
                <div>
                  <strong>{sale?.buyerName}</strong> ← {pix?.payerName}
                  <div className="hint">
                    {brl(s.amount)} · {s.reason}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    const r = amortize(s.saleId, s.pixPaymentId, s.amount, 'Conferência TXID')
                    showToast(r.ok ? 'Baixa aplicada.' : r.error || 'Erro')
                  }}
                >
                  Amortizar
                </button>
              </div>
            )
          })}
        </section>
      )}

      {isAdmin && adminTab === 'equipe' && (
        <section className="grid-2">
          <form
            className="panel"
            onSubmit={(e) => {
              e.preventDefault()
              const fd = new FormData(e.currentTarget)
              const result = addMember({
                name: String(fd.get('name') || ''),
                phone: String(fd.get('phone') || ''),
                pin: String(fd.get('pin') || ''),
              })
              if (!result.ok) return showToast(result.error)
              e.currentTarget.reset()
              showToast(`Membro ${result.member.name} criado.`)
            }}
          >
            <div className="panel-head">
              <div>
                <h2>Cadastrar membro</h2>
                <p>PIN para o membro entrar e ver só os números dele.</p>
              </div>
            </div>
            <div className="form-grid">
              <label>
                Nome
                <input name="name" required />
              </label>
              <label>
                WhatsApp
                <input name="phone" />
              </label>
              <label className="full">
                PIN (mín. 4)
                <input name="pin" required minLength={4} inputMode="numeric" />
              </label>
            </div>
            <div className="btn-row">
              <button className="btn btn-primary" type="submit">
                Salvar membro
              </button>
            </div>
          </form>

          <form
            className="panel"
            onSubmit={(e) => {
              e.preventDefault()
              const fd = new FormData(e.currentTarget)
              const result = assignRange({
                memberId: String(fd.get('memberId') || ''),
                raffleId: String(fd.get('raffleId') || ''),
                fromNumber: Number(fd.get('fromNumber')),
                toNumber: Number(fd.get('toNumber')),
              })
              if (!result.ok) return showToast(result.error || 'Erro')
              e.currentTarget.reset()
              showToast('Faixa atribuída.')
            }}
          >
            <div className="panel-head">
              <div>
                <h2>Atribuir números (X até Y)</h2>
              </div>
            </div>
            <div className="form-grid">
              <label className="full">
                Membro
                <select name="memberId" required defaultValue="">
                  <option value="" disabled>
                    Selecione
                  </option>
                  {members.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="full">
                Evento/rifa
                <select name="raffleId" required defaultValue="">
                  <option value="" disabled>
                    Selecione
                  </option>
                  {raffles.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.eventName} — {r.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                De
                <input name="fromNumber" type="number" min={1} required />
              </label>
              <label>
                Até
                <input name="toNumber" type="number" min={1} required />
              </label>
            </div>
            <div className="btn-row">
              <button className="btn btn-primary" type="submit">
                Amarrar faixa
              </button>
            </div>
          </form>

          <div className="panel" style={{ gridColumn: '1 / -1' }}>
            <h2>Membros e faixas</h2>
            {members.map((m) => (
              <article key={m.id} style={{ marginBottom: '1rem' }}>
                <strong>{m.name}</strong> · PIN {m.pin}
                <div className="hint">
                  {numberRanges
                    .filter((r) => r.memberId === m.id)
                    .map((r) => {
                      const raffle = raffles.find((x) => x.id === r.raffleId)
                      return (
                        <div key={r.id}>
                          {raffle?.eventName || 'Rifa'}: {r.fromNumber}–{r.toNumber}{' '}
                          <button type="button" className="btn btn-ghost" onClick={() => removeRange(r.id)}>
                            remover faixa
                          </button>
                        </div>
                      )
                    })}
                </div>
                <button type="button" className="btn btn-danger" onClick={() => removeMember(m.id)}>
                  Remover membro
                </button>
              </article>
            ))}
          </div>
        </section>
      )}

      {isAdmin && adminTab === 'eventos' && (
        <section className="grid-2">
          <form
            className="panel"
            onSubmit={(e) => {
              e.preventDefault()
              const fd = new FormData(e.currentTarget)
              addRaffle({
                eventName: String(fd.get('eventName') || ''),
                name: String(fd.get('name') || ''),
                prize: String(fd.get('prize') || ''),
                ticketPrice: Number(fd.get('ticketPrice')),
                totalNumbers: Number(fd.get('totalNumbers')),
              })
              e.currentTarget.reset()
              showToast('Evento/rifa criado.')
            }}
          >
            <div className="panel-head">
              <div>
                <h2>Novo evento / rifa</h2>
              </div>
            </div>
            <div className="form-grid">
              <label className="full">
                Nome do evento
                <input name="eventName" required placeholder="Ex.: Festa da Turma 2026" />
              </label>
              <label className="full">
                Nome da rifa
                <input name="name" required />
              </label>
              <label>
                Preço do nº
                <input name="ticketPrice" type="number" step="0.01" min="0.01" required />
              </label>
              <label>
                Total de números
                <input name="totalNumbers" type="number" min="1" required />
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
            <h2>Eventos</h2>
            {raffles.map((r) => (
              <article key={r.id} style={{ marginBottom: '0.85rem' }}>
                <strong>{r.eventName}</strong>
                <div className="hint">
                  {r.name} · {brl(r.ticketPrice)} · {r.totalNumbers} números · {r.prize}
                </div>
                <button type="button" className="btn btn-danger" onClick={() => removeRaffle(r.id)}>
                  Remover
                </button>
              </article>
            ))}
          </div>
        </section>
      )}

      {isAdmin && adminTab === 'vendas' && (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Todas as vendas</h2>
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Membro</th>
                  <th>Comprador</th>
                  <th>Números</th>
                  <th>Recebimento</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {sales.map((s) => (
                  <tr key={s.id}>
                    <td>{members.find((m) => m.id === s.memberId)?.name || '—'}</td>
                    <td>{s.buyerName}</td>
                    <td>{formatNumbers(s.numbers)}</td>
                    <td>
                      {s.paymentMethod === 'dinheiro' ? 'Dinheiro' : `PIX/${s.pixDestination || '—'}`}
                      <div className="hint">
                        {brl(s.paidAmount)}/{brl(s.totalAmount)}
                      </div>
                    </td>
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
        </section>
      )}

      {isAdmin && adminTab === 'pix' && (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Importar CSV e baixar por TXID</h2>
              <p>Só ADM. Casa TXID/E2E do extrato com o comprovante salvo na venda.</p>
            </div>
            <button type="button" className="btn btn-secondary" onClick={() => setImportPreview(parsePixCsv(SAMPLE_CSV))}>
              Exemplo
            </button>
          </div>
          <textarea
            value={csvText}
            onChange={(e) => {
              setCsvText(e.target.value)
              setImportPreview(parsePixCsv(e.target.value))
            }}
            placeholder="Cole o CSV do banco"
          />
          {importPreview && (
            <>
              <p className="hint">
                {importPreview.rows.length} linhas · {txidPreview.length} matches TXID
              </p>
              <div className="btn-row">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    const r = importCsvAndSettleByTxid(importPreview.rows)
                    showToast(`Importados ${r.imported}. Baixas ${r.settled}.`)
                    setCsvText('')
                    setImportPreview(null)
                  }}
                >
                  Importar e compensar
                </button>
              </div>
            </>
          )}
        </section>
      )}

      {isAdmin && adminTab === 'txid' && (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>TXIDs / comprovantes</h2>
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
                </tr>
              </thead>
              <tbody>
                {pixCharges.map((c) => (
                  <tr key={c.id}>
                    <td>{sales.find((s) => s.id === c.saleId)?.buyerName || '—'}</td>
                    <td>
                      <code>{c.txid}</code>
                    </td>
                    <td>{brl(c.amount)}</td>
                    <td>
                      <span className={`badge ${c.status === 'paid' ? 'quitado' : 'pendente'}`}>{c.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {isAdmin && adminTab === 'amortizacao' && (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Livro de baixas</h2>
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Quando</th>
                  <th>Venda</th>
                  <th>Valor</th>
                  <th>Obs.</th>
                </tr>
              </thead>
              <tbody>
                {amortizations.map((a) => (
                  <tr key={a.id}>
                    <td>{new Date(a.createdAt).toLocaleString('pt-BR')}</td>
                    <td>{sales.find((s) => s.id === a.saleId)?.buyerName || '—'}</td>
                    <td>{brl(a.amount)}</td>
                    <td>{a.note || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {isAdmin && adminTab === 'relatorios' && (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Relatórios / prestação de contas</h2>
              <p>Dinheiro e PIX na conta do vendedor ficam em aberto até registrar a entrega à entidade.</p>
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Membro</th>
                  <th>Nº vendidos</th>
                  <th>Esperado</th>
                  <th>Recebido</th>
                  <th>Dinheiro c/ ele</th>
                  <th>PIX entidade</th>
                  <th>PIX vendedor em aberto</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {reports.map((r) => (
                  <tr key={r.member.id}>
                    <td>{r.member.name}</td>
                    <td>{r.soldCount}</td>
                    <td>{brl(r.expected)}</td>
                    <td>{brl(r.received)}</td>
                    <td>{brl(r.cashOpen)}</td>
                    <td>{brl(r.pixEntidade)}</td>
                    <td>{brl(r.pixVendedorOpen)}</td>
                    <td>
                      {r.cashOpen > 0 && (
                        <button
                          type="button"
                          className="btn btn-secondary"
                          onClick={() => {
                            addMemberSettlement({ memberId: r.member.id, amount: r.cashOpen, kind: 'dinheiro', note: 'Prestação dinheiro' })
                            showToast('Dinheiro quitado com a entidade.')
                          }}
                        >
                          Receber dinheiro
                        </button>
                      )}
                      {r.pixVendedorOpen > 0 && (
                        <button
                          type="button"
                          className="btn btn-secondary"
                          onClick={() => {
                            addMemberSettlement({
                              memberId: r.member.id,
                              amount: r.pixVendedorOpen,
                              kind: 'pix_vendedor',
                              note: 'Repasse PIX vendedor',
                            })
                            showToast('PIX do vendedor prestado.')
                          }}
                        >
                          Receber PIX vendedor
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
