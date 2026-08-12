import { useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { getAuthRecord, getSession, logout } from './auth'
import { parsePixCsv, SAMPLE_CSV } from './csvImport'
import { NumberGrid } from './NumberGrid'
import { isSupabaseConfigured, supabase } from './lib/supabase'
import { loadCloudSession, saveCloudSession } from './lib/workspace'
import { brl, formatNumbers, useStore } from './store'
import { TeamChat } from './TeamChat'
import { previewTxidMatches } from './txidMatch'
import type { CashDestination, PaymentMethod, PaymentStatus, PixDestination } from './types'

type AdminTab = 'painel' | 'equipe' | 'transferencias' | 'eventos' | 'vendas' | 'pix' | 'txid' | 'amortizacao' | 'relatorios'
type MemberTab = 'blocos' | 'vendas'
type ReportSection = 'prestacao' | 'vendas' | 'transferencias'

const statusLabel: Record<PaymentStatus, string> = {
  pendente: 'Pendente',
  parcial: 'Parcial',
  quitado: 'Quitado',
  divergente: 'Divergente',
}

function openProof(dataUrl: string) {
  try {
    const [header, b64] = dataUrl.split(',')
    if (!b64) {
      window.open(dataUrl, '_blank', 'noopener,noreferrer')
      return
    }
    const mime = header.match(/data:([^;]+)/)?.[1] || 'application/octet-stream'
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i)
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }))
    window.open(url, '_blank', 'noopener,noreferrer')
  } catch {
    window.open(dataUrl, '_blank', 'noopener,noreferrer')
  }
}

async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(new Error('Falha ao ler arquivo'))
    reader.readAsDataURL(file)
  })
}

function ProofIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path d="M14 2v6h6" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M8 13h8M8 17h5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

export default function LocalApp() {
  const session = getSession()
  const isAdmin = session?.role === 'admin'
  const memberId = session?.memberId || ''

  const [adminTab, setAdminTab] = useState<AdminTab>('painel')
  const [memberTab, setMemberTab] = useState<MemberTab>('blocos')
  const [toast, setToast] = useState<string | null>(null)
  const [selectedNumbers, setSelectedNumbers] = useState<number[]>([])
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('dinheiro')
  const [pixDestination, setPixDestination] = useState<PixDestination>('entidade')
  const [cashDestination, setCashDestination] = useState<CashDestination>('vendedor')
  const [saleRaffleId, setSaleRaffleId] = useState('')
  const [openBlockId, setOpenBlockId] = useState<string | null>(null)
  const [openEventId, setOpenEventId] = useState<string | null>(null)
  const [filterEventId, setFilterEventId] = useState('')
  const [assignBlockId, setAssignBlockId] = useState('')
  const [transferBlockId, setTransferBlockId] = useState('')
  const [transferEventId, setTransferEventId] = useState('')
  const [proofDataUrl, setProofDataUrl] = useState('')
  const [reportSection, setReportSection] = useState<ReportSection>('prestacao')
  const [csvText, setCsvText] = useState('')
  const [importPreview, setImportPreview] = useState<ReturnType<typeof parsePixCsv> | null>(null)

  const raffles = useStore((s) => s.raffles)
  const members = useStore((s) => s.members)
  const blocks = useStore((s) => s.blocks)
  const sales = useStore((s) => s.sales)
  const pixPayments = useStore((s) => s.pixPayments)
  const amortizations = useStore((s) => s.amortizations)
  const pixCharges = useStore((s) => s.pixCharges)
  const memberSettlements = useStore((s) => s.memberSettlements)
  const blockTransfers = useStore((s) => s.blockTransfers)
  const addRaffle = useStore((s) => s.addRaffle)
  const removeRaffle = useStore((s) => s.removeRaffle)
  const addMember = useStore((s) => s.addMember)
  const removeMember = useStore((s) => s.removeMember)
  const assignBlock = useStore((s) => s.assignBlock)
  const transferBlock = useStore((s) => s.transferBlock)
  const unassignBlock = useStore((s) => s.unassignBlock)
  const memberNumbers = useStore((s) => s.memberNumbers)
  const soldNumbers = useStore((s) => s.soldNumbers)
  const blockStats = useStore((s) => s.blockStats)
  const memberBlockStats = useStore((s) => s.memberBlockStats)
  const addSale = useStore((s) => s.addSale)
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
  const myBlocks = useMemo(
    () =>
      blocks
        .filter((b) => b.raffleId === currentRaffleId && b.memberId === memberId)
        .sort((a, b) => a.index - b.index),
    [blocks, currentRaffleId, memberId],
  )
  const openBlock = myBlocks.find((b) => b.id === openBlockId) || null
  const myNumbers =
    memberId && currentRaffleId ? memberNumbers(memberId, currentRaffleId, openBlock?.id) : []
  const sold = currentRaffleId ? soldNumbers(currentRaffleId) : new Set<number>()
  const myOpenTotal = myBlocks.reduce((acc, b) => acc + blockStats(b.id).open, 0)

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
      const cashVendedor = mSales
        .filter((s) => s.paymentMethod === 'dinheiro' && (s.cashDestination || 'vendedor') === 'vendedor')
        .reduce((acc, s) => acc + s.paidAmount, 0)
      const cashLoja = mSales
        .filter((s) => s.paymentMethod === 'dinheiro' && s.cashDestination === 'loja')
        .reduce((acc, s) => acc + s.paidAmount, 0)
      const cash = cashVendedor + cashLoja
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
        cashVendedor,
        cashLoja,
        pixEntidade,
        pixVendedor,
        cashOpen: Math.max(0, cashVendedor - settledCash),
        pixVendedorOpen: Math.max(0, pixVendedor - settledPix),
      }
    })
  }, [members, sales, memberSettlements])

  const totals = useMemo(() => {
    const expected = sales.reduce((a, s) => a + s.totalAmount, 0)
    const received = sales.reduce((a, s) => a + s.paidAmount, 0)
    const cashLoja = sales
      .filter((s) => s.paymentMethod === 'dinheiro' && s.cashDestination === 'loja')
      .reduce((a, s) => a + s.paidAmount, 0)
    const cashVendedorOpen = reports.reduce((a, r) => a + r.cashOpen, 0)
    const pixEntidade = sales
      .filter((s) => s.paymentMethod === 'pix' && s.pixDestination === 'entidade')
      .reduce((a, s) => a + s.paidAmount, 0)
    const pixVendedorOpen = reports.reduce((a, r) => a + r.pixVendedorOpen, 0)
    return { expected, received, cashLoja, cashVendedorOpen, pixEntidade, pixVendedorOpen }
  }, [sales, reports])

  const who = isAdmin
    ? getAuthRecord()?.organizerName || session?.memberName || 'ADM'
    : session?.memberName || 'Membro'

  const toggleNumber = (n: number) => {
    setSelectedNumbers((prev) => (prev.includes(n) ? prev.filter((x) => x !== n) : [...prev, n].sort((a, b) => a - b)))
  }

  const onCreateSale = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!memberId && !isAdmin) return
    const fd = new FormData(e.currentTarget)
    const sellerId = isAdmin ? String(fd.get('memberId') || '') : memberId
    const raffleId = String(fd.get('raffleId') || currentRaffleId)
    let proof = proofDataUrl
    const file = (e.currentTarget.elements.namedItem('proofFile') as HTMLInputElement | null)?.files?.[0]
    if (file) {
      try {
        proof = await fileToDataUrl(file)
      } catch {
        return showToast('Não foi possível ler o comprovante.')
      }
    }
    const result = addSale({
      raffleId,
      memberId: sellerId,
      buyerName: String(fd.get('buyerName') || ''),
      buyerPhone: String(fd.get('buyerPhone') || ''),
      numbers: selectedNumbers,
      paymentMethod,
      pixDestination: paymentMethod === 'pix' ? pixDestination : undefined,
      cashDestination: paymentMethod === 'dinheiro' ? cashDestination : undefined,
      notes: String(fd.get('notes') || ''),
      proofTxid: String(fd.get('proofTxid') || ''),
      proofImageDataUrl: proof || undefined,
      receivedNow: paymentMethod === 'dinheiro' || String(fd.get('receivedNow') || '') === 'sim',
      blockId: openBlockId || undefined,
    })
    if (!result.ok) return showToast(result.error)
    e.currentTarget.reset()
    setSelectedNumbers([])
    setPaymentMethod('dinheiro')
    setCashDestination('vendedor')
    setProofDataUrl('')
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
          <div className="nav-scroll">
            <nav className="nav" aria-label="Menu principal">
              {isAdmin
                ? (
                    [
                      ['painel', 'Painel', 'Painel'],
                      ['equipe', 'Equipe', 'Equipe'],
                      ['transferencias', 'Transferências', 'Transf.'],
                      ['eventos', 'Eventos', 'Eventos'],
                      ['vendas', 'Vendas', 'Vendas'],
                      ['pix', 'PIX/CSV', 'PIX'],
                      ['txid', 'TXID', 'TXID'],
                      ['amortizacao', 'Baixas', 'Baixas'],
                      ['relatorios', 'Relatórios', 'Relat.'],
                    ] as const
                  ).map(([id, full, short]) => (
                    <button
                      key={id}
                      type="button"
                      className={adminTab === id ? 'active' : ''}
                      onClick={() => setAdminTab(id)}
                    >
                      <span className="nav-label-full">{full}</span>
                      <span className="nav-label-short">{short}</span>
                    </button>
                  ))
                : (
                    [
                      ['blocos', 'Meus blocos', 'Blocos'],
                      ['vendas', 'Minhas vendas', 'Vendas'],
                    ] as const
                  ).map(([id, full, short]) => (
                    <button
                      key={id}
                      type="button"
                      className={memberTab === id ? 'active' : ''}
                      onClick={() => setMemberTab(id)}
                    >
                      <span className="nav-label-full">{full}</span>
                      <span className="nav-label-short">{short}</span>
                    </button>
                  ))}
            </nav>
          </div>
          <button
            type="button"
            className="btn btn-secondary btn-sair"
            onClick={async () => {
              saveCloudSession(null)
              logout()
              if (isSupabaseConfigured && supabase) await supabase.auth.signOut()
              window.location.reload()
            }}
          >
            Sair
          </button>
        </div>
      </header>

      {/* MEMBER VIEW */}
      {!isAdmin && memberTab === 'blocos' && !openBlock && (
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Meus blocos</h2>
              <p>
                Toque em um bloco para vender os números. Em aberto no total: <strong>{myOpenTotal}</strong>
              </p>
            </div>
            <label>
              Evento/rifa
              <select
                value={currentRaffleId}
                onChange={(e) => {
                  setSaleRaffleId(e.target.value)
                  setSelectedNumbers([])
                  setOpenBlockId(null)
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
          <div className="block-grid">
            {myBlocks.length === 0 && <p className="empty">Nenhum bloco atribuído a você neste evento.</p>}
            {myBlocks.map((b) => {
              const st = blockStats(b.id)
              const soldOut = st.open === 0
              return (
                <button
                  key={b.id}
                  type="button"
                  className={`block-card ${soldOut ? 'sold-out' : 'has-open'}`}
                  onClick={() => {
                    setOpenBlockId(b.id)
                    setSelectedNumbers([])
                    setMemberTab('vendas')
                  }}
                >
                  <strong>{b.label}</strong>
                  <span className="hint">
                    nº {String(b.fromNumber).padStart(2, '0')}–{String(b.toNumber).padStart(2, '0')}
                  </span>
                  <span className="block-open">{st.open} abertos</span>
                  <span className="hint">
                    {st.sold}/{st.total} vendidos
                  </span>
                </button>
              )
            })}
          </div>
        </section>
      )}

      {!isAdmin && (memberTab === 'vendas' || openBlock) && (
        <section className="grid-2">
          <form className="panel" onSubmit={onCreateSale}>
            <div className="panel-head">
              <div>
                <h2>{openBlock ? `Vender · ${openBlock.label}` : 'Lançar venda'}</h2>
                <p>
                  {openBlock
                    ? `${String(openBlock.fromNumber).padStart(2, '0')}–${String(openBlock.toNumber).padStart(2, '0')} · ${blockStats(openBlock.id).open} abertos`
                    : 'Abra um bloco em “Meus blocos” para vender com segurança.'}
                </p>
              </div>
              {openBlock && (
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => {
                    setOpenBlockId(null)
                    setSelectedNumbers([])
                    setMemberTab('blocos')
                  }}
                >
                  Voltar aos blocos
                </button>
              )}
            </div>
            {!openBlock ? (
              <p className="empty">Escolha um bloco primeiro para ver os números disponíveis.</p>
            ) : (
              <>
                <div className="form-grid">
                  <input type="hidden" name="raffleId" value={currentRaffleId} />
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
                    <select value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value as PaymentMethod)} required>
                      <option value="dinheiro">Dinheiro</option>
                      <option value="pix">PIX</option>
                    </select>
                  </label>
                  {paymentMethod === 'dinheiro' && (
                    <label className="full">
                      Destino do dinheiro
                      <select
                        value={cashDestination}
                        onChange={(e) => setCashDestination(e.target.value as CashDestination)}
                        required
                      >
                        <option value="vendedor">Ficou comigo (vendedor)</option>
                        <option value="loja">Já foi pra loja / entidade</option>
                      </select>
                    </label>
                  )}
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
                    Comprovante (imagem ou PDF, opcional)
                    <input
                      name="proofFile"
                      type="file"
                      accept="image/*,application/pdf"
                      onChange={async (ev) => {
                        const file = ev.target.files?.[0]
                        if (!file) {
                          setProofDataUrl('')
                          return
                        }
                        try {
                          setProofDataUrl(await fileToDataUrl(file))
                        } catch {
                          setProofDataUrl('')
                          showToast('Não foi possível ler o comprovante.')
                        }
                      }}
                    />
                  </label>
                  <label className="full">
                    Observações (opcional)
                    <textarea name="notes" />
                  </label>
                </div>
                <NumberGrid numbers={myNumbers} sold={sold} selected={new Set(selectedNumbers)} onToggle={toggleNumber} />
                <div className="btn-row">
                  <button className="btn btn-primary" type="submit" disabled={!selectedNumbers.length}>
                    Salvar venda ({selectedNumbers.length} nº ·{' '}
                    {brl(selectedNumbers.length * (activeRaffles.find((r) => r.id === currentRaffleId)?.ticketPrice || 0))})
                  </button>
                </div>
              </>
            )}
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
                        {s.paymentMethod === 'dinheiro'
                          ? `Dinheiro (${s.cashDestination === 'loja' ? 'loja' : 'vendedor'})`
                          : `PIX (${s.pixDestination === 'entidade' ? 'entidade' : 'vendedor'})`}
                        {(s.proofImageDataUrl || pixCharges.find((c) => c.saleId === s.id)?.proofImageDataUrl) && (
                          <>
                            {' · '}
                            <button
                              type="button"
                              className="btn-proof"
                              title="Abrir comprovante"
                              onClick={() =>
                                openProof(
                                  s.proofImageDataUrl ||
                                    pixCharges.find((c) => c.saleId === s.id)?.proofImageDataUrl ||
                                    '',
                                )
                              }
                            >
                              <ProofIcon />
                            </button>
                          </>
                        )}
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
              {isSupabaseConfigured && loadCloudSession()?.workspace.accessCode && (
                <p className="hint">
                  Nuvem ligada · código da equipe para membros:{' '}
                  <strong>{loadCloudSession()!.workspace.accessCode}</strong>
                </p>
              )}
            </div>
            <div className="btn-row" style={{ marginTop: 0 }}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  seedDemo()
                  showToast('Demo: 4 blocos×50. Carlos PIN 1234 (blocos 1–2), Fernanda PIN 5678 (3–4).')
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
              const blockId = assignBlockId || String(fd.get('blockId') || '')
              const result = assignBlock(blockId, String(fd.get('memberId') || ''))
              if (!result.ok) return showToast(result.error || 'Erro')
              setAssignBlockId('')
              e.currentTarget.reset()
              showToast('Bloco atribuído ao membro.')
            }}
          >
            <div className="panel-head">
              <div>
                <h2>Atribuir bloco livre</h2>
                <p>Verde = livre. Cinza = já atribuído (indisponível aqui). Transferências entre membros ficam na aba Transferências.</p>
              </div>
            </div>
            <div className="form-grid">
              <label className="full">
                Evento
                <select
                  value={filterEventId || raffles[0]?.id || ''}
                  onChange={(e) => {
                    setFilterEventId(e.target.value)
                    setAssignBlockId('')
                  }}
                >
                  {raffles.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.eventName}
                    </option>
                  ))}
                </select>
              </label>
              <div className="full">
                <span className="field-label">Blocos do evento</span>
                <div className="transfer-block-list">
                  {blocks
                    .filter((b) => b.raffleId === (filterEventId || raffles[0]?.id))
                    .sort((a, b) => a.index - b.index)
                    .map((b) => {
                      const st = blockStats(b.id)
                      const assigned = Boolean(b.memberId)
                      const owner = members.find((m) => m.id === b.memberId)?.name || 'livre'
                      return (
                        <button
                          key={b.id}
                          type="button"
                          className={`transfer-block ${assigned ? 'assigned' : 'free'} ${assignBlockId === b.id ? 'selected' : ''}`}
                          disabled={assigned}
                          onClick={() => {
                            if (assigned) return
                            setAssignBlockId(b.id)
                          }}
                        >
                          <strong>{b.label}</strong>
                          <span>
                            {b.fromNumber}–{b.toNumber} · {owner}
                          </span>
                          <span>{assigned ? 'Indisponível' : `${st.open} abertos`}</span>
                        </button>
                      )
                    })}
                </div>
                <input type="hidden" name="blockId" value={assignBlockId} />
                {!assignBlockId && <p className="hint">Selecione um bloco livre (verde) acima.</p>}
              </div>
              <label className="full">
                Para o membro
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
            </div>
            <div className="btn-row">
              <button className="btn btn-primary" type="submit" disabled={!assignBlockId}>
                Atribuir bloco
              </button>
            </div>
          </form>

          <div className="panel" style={{ gridColumn: '1 / -1' }}>
            <div className="panel-head">
              <div>
                <h2>Membros e eventos</h2>
              </div>
              <label>
                Filtrar evento
                <select value={filterEventId} onChange={(e) => setFilterEventId(e.target.value)}>
                  <option value="">Todos</option>
                  {raffles.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.eventName}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="member-cards">
              {members.map((m) => {
                const memberBlocks = blocks.filter((b) => b.memberId === m.id && (!filterEventId || b.raffleId === filterEventId))
                const events = [
                  ...new Set(
                    memberBlocks
                      .map((b) => raffles.find((r) => r.id === b.raffleId)?.eventName)
                      .filter(Boolean),
                  ),
                ] as string[]
                const st = memberBlockStats(m.id, filterEventId || undefined)
                return (
                  <article key={m.id} className="member-card">
                    <strong>{m.name}</strong>
                    <div className="hint">PIN {m.pin}</div>
                    <div className="hint">
                      Eventos: {events.length ? events.join(', ') : 'nenhum bloco neste filtro'}
                    </div>
                    <div className="hint">
                      {st.blocks} blocos · {st.openBlocks} com aberto · {st.soldOutBlocks} esgotados · {st.openNumbers} nº livres
                    </div>
                    <div className="mini-blocks">
                      {memberBlocks
                        .sort((a, b) => a.index - b.index)
                        .map((b) => {
                          const bs = blockStats(b.id)
                          const soldOut = bs.open <= 0
                          return (
                            <div key={b.id} className={`mini-block ${soldOut ? 'sold-out' : 'has-open'}`}>
                              {b.label} · {bs.open}/{bs.total}
                              <button type="button" className="btn btn-ghost" onClick={() => unassignBlock(b.id)}>
                                liberar
                              </button>
                            </div>
                          )
                        })}
                    </div>
                    <button type="button" className="btn btn-danger" onClick={() => removeMember(m.id)}>
                      Remover membro
                    </button>
                  </article>
                )
              })}
            </div>
          </div>
        </section>
      )}

      {isAdmin && adminTab === 'transferencias' && (
        <section className="grid-2">
          <form
            className="panel"
            onSubmit={(e) => {
              e.preventDefault()
              const fd = new FormData(e.currentTarget)
              const blockId = transferBlockId || String(fd.get('blockId') || '')
              const result = transferBlock(blockId, String(fd.get('memberId') || ''))
              if (!result.ok) return showToast(result.error || 'Erro')
              setTransferBlockId('')
              e.currentTarget.reset()
              showToast('Transferência registrada.')
            }}
          >
            <div className="panel-head">
              <div>
                <h2>Transferir bloco entre membros</h2>
                <p>Azul = tem números abertos. Vermelho = vendido (não transfere). Cada movimentação fica no relatório.</p>
              </div>
            </div>
            <div className="form-grid">
              <label className="full">
                Evento
                <select
                  value={transferEventId || filterEventId || raffles[0]?.id || ''}
                  onChange={(e) => {
                    setTransferEventId(e.target.value)
                    setTransferBlockId('')
                  }}
                >
                  {raffles.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.eventName}
                    </option>
                  ))}
                </select>
              </label>
              <div className="full">
                <span className="field-label">Blocos já atribuídos</span>
                <div className="transfer-block-list">
                  {blocks
                    .filter((b) => b.raffleId === (transferEventId || filterEventId || raffles[0]?.id) && b.memberId)
                    .sort((a, b) => a.index - b.index)
                    .map((b) => {
                      const st = blockStats(b.id)
                      const soldOut = st.open <= 0
                      const owner = members.find((m) => m.id === b.memberId)?.name || '—'
                      return (
                        <button
                          key={b.id}
                          type="button"
                          className={`transfer-block ${soldOut ? 'sold-out' : 'has-open'} ${transferBlockId === b.id ? 'selected' : ''}`}
                          disabled={soldOut}
                          onClick={() => {
                            if (soldOut) {
                              showToast('Esse bloco não pode ser transferido: está vendido (sem números abertos).')
                              return
                            }
                            setTransferBlockId(b.id)
                          }}
                        >
                          <strong>{b.label}</strong>
                          <span className="owner-assigned">
                            {b.fromNumber}–{b.toNumber} · {owner}
                          </span>
                          <span>{soldOut ? 'Vendido' : `${st.open} abertos`}</span>
                        </button>
                      )
                    })}
                </div>
                <input type="hidden" name="blockId" value={transferBlockId} />
                {!transferBlockId && <p className="hint">Selecione um bloco azul acima.</p>}
              </div>
              <label className="full">
                Novo membro
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
            </div>
            <div className="btn-row">
              <button className="btn btn-primary" type="submit" disabled={!transferBlockId}>
                Transferir bloco
              </button>
            </div>
          </form>

          <div className="panel">
            <div className="panel-head">
              <div>
                <h2>Últimas movimentações</h2>
                <p>Rastro de atribuições, transferências e liberações.</p>
              </div>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Quando</th>
                    <th>Tipo</th>
                    <th>Bloco</th>
                    <th>De</th>
                    <th>Para</th>
                  </tr>
                </thead>
                <tbody>
                  {blockTransfers.slice(0, 40).map((t) => {
                    const block = blocks.find((b) => b.id === t.blockId)
                    const kindLabel =
                      t.kind === 'assign' ? 'Atribuição' : t.kind === 'transfer' ? 'Transferência' : 'Liberação'
                    return (
                      <tr key={t.id}>
                        <td>{new Date(t.createdAt).toLocaleString('pt-BR')}</td>
                        <td>{kindLabel}</td>
                        <td>{block?.label || '—'}</td>
                        <td>{t.fromMemberId ? members.find((m) => m.id === t.fromMemberId)?.name || '—' : 'livre'}</td>
                        <td>{t.toMemberId ? members.find((m) => m.id === t.toMemberId)?.name || '—' : 'livre'}</td>
                      </tr>
                    )
                  })}
                  {blockTransfers.length === 0 && (
                    <tr>
                      <td colSpan={5}>
                        <p className="empty">Nenhuma movimentação ainda.</p>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      {isAdmin && adminTab === 'eventos' && (
        <section>
          {!openEventId && (
            <>
              <form
                className="panel"
                style={{ marginBottom: '1rem' }}
                onSubmit={(e) => {
                  e.preventDefault()
                  const fd = new FormData(e.currentTarget)
                  const result = addRaffle({
                    eventName: String(fd.get('eventName') || ''),
                    name: String(fd.get('name') || ''),
                    prize: String(fd.get('prize') || ''),
                    ticketPrice: Number(fd.get('ticketPrice')),
                    blockCount: Number(fd.get('blockCount')),
                    numbersPerBlock: Number(fd.get('numbersPerBlock')),
                    startDate: String(fd.get('startDate') || '') || undefined,
                    drawDate: String(fd.get('drawDate') || '') || undefined,
                  })
                  if (!result.ok) return showToast(result.error)
                  e.currentTarget.reset()
                  showToast(`Evento criado com ${result.raffle.blockCount} blocos.`)
                }}
              >
                <div className="panel-head">
                  <div>
                    <h2>Novo evento / rifa por blocos</h2>
                    <p>Ex.: 4 blocos × 50 cartelas = 200 números.</p>
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
                    Qtd. de blocos
                    <input name="blockCount" type="number" min="1" required defaultValue={4} />
                  </label>
                  <label>
                    Cartelas por bloco
                    <input name="numbersPerBlock" type="number" min="1" required defaultValue={50} />
                  </label>
                  <label>
                    Início das vendas
                    <input name="startDate" type="date" />
                  </label>
                  <label>
                    Data do sorteio
                    <input name="drawDate" type="date" />
                  </label>
                  <label className="full">
                    Prêmios
                    <input name="prize" required placeholder="Ex.: Moto, iPhone, TV" />
                  </label>
                </div>
                <div className="btn-row">
                  <button className="btn btn-primary" type="submit">
                    Criar com blocos
                  </button>
                </div>
              </form>

              <div className="event-grid">
                {raffles.map((r) => {
                  const eventBlocks = blocks.filter((b) => b.raffleId === r.id)
                  const openNums = eventBlocks.reduce((acc, b) => acc + blockStats(b.id).open, 0)
                  return (
                    <button key={r.id} type="button" className="event-card" onClick={() => setOpenEventId(r.id)}>
                      <strong>{r.eventName}</strong>
                      <span className="prize-line">{r.prize}</span>
                      <span className="hint">
                        {brl(r.ticketPrice)} · {r.blockCount || eventBlocks.length} blocos · {r.totalNumbers} números
                      </span>
                      <span className="hint">{openNums} nº ainda abertos</span>
                      <span className="hint">Toque para abrir</span>
                    </button>
                  )
                })}
              </div>
            </>
          )}

          {openEventId &&
            (() => {
              const r = raffles.find((x) => x.id === openEventId)
              if (!r) return null
              const eventBlocks = blocks.filter((b) => b.raffleId === r.id).sort((a, b) => a.index - b.index)
              const openNums = eventBlocks.reduce((acc, b) => acc + blockStats(b.id).open, 0)
              return (
                <section className="panel">
                  <div className="panel-head">
                    <div>
                      <button type="button" className="btn btn-secondary" onClick={() => setOpenEventId(null)}>
                        ← Voltar aos eventos
                      </button>
                    </div>
                    <button type="button" className="btn btn-danger" onClick={() => { removeRaffle(r.id); setOpenEventId(null) }}>
                      Remover evento
                    </button>
                  </div>
                  <header className="event-hero">
                    <p className="event-kicker">{r.name}</p>
                    <h2>{r.eventName}</h2>
                    <p className="event-prize">Premiação: {r.prize}</p>
                    <div className="event-meta">
                      <span>
                        <strong>Valor</strong>
                        {brl(r.ticketPrice)} / número
                      </span>
                      <span>
                        <strong>Blocos</strong>
                        {r.blockCount || eventBlocks.length} × {r.numbersPerBlock || '—'}
                      </span>
                      <span>
                        <strong>Números</strong>
                        {r.totalNumbers} (abertos: {openNums})
                      </span>
                      <span>
                        <strong>Início</strong>
                        {r.startDate ? new Date(r.startDate).toLocaleDateString('pt-BR') : '—'}
                      </span>
                      <span>
                        <strong>Sorteio</strong>
                        {r.drawDate ? new Date(r.drawDate).toLocaleDateString('pt-BR') : '—'}
                      </span>
                    </div>
                  </header>
                  <div className="block-grid">
                    {eventBlocks.map((b) => {
                      const st = blockStats(b.id)
                      const soldOut = st.open <= 0
                      const owner = members.find((m) => m.id === b.memberId)?.name
                      return (
                        <div key={b.id} className={`block-card ${soldOut ? 'sold-out' : 'has-open'}`}>
                          <strong>{b.label}</strong>
                          <span className="hint">
                            nº {b.fromNumber}–{b.toNumber}
                          </span>
                          <span className="block-open">{soldOut ? 'Vendido' : `${st.open} abertos`}</span>
                          <span className={owner ? 'owner-assigned' : 'owner-free'}>{owner || 'livre'}</span>
                        </div>
                      )
                    })}
                  </div>
                </section>
              )
            })()}
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
                  <th>Comprovante</th>
                </tr>
              </thead>
              <tbody>
                {sales.map((s) => (
                  <tr key={s.id}>
                    <td>{members.find((m) => m.id === s.memberId)?.name || '—'}</td>
                    <td>{s.buyerName}</td>
                    <td>{formatNumbers(s.numbers)}</td>
                    <td>
                      {s.paymentMethod === 'dinheiro'
                        ? `Dinheiro (${s.cashDestination === 'loja' ? 'loja' : 'vendedor'})`
                        : `PIX/${s.pixDestination || '—'}`}
                      <div className="hint">
                        {brl(s.paidAmount)}/{brl(s.totalAmount)}
                      </div>
                    </td>
                    <td>
                      <span className={`badge ${s.status}`}>{statusLabel[s.status]}</span>
                    </td>
                    <td>
                      {(s.proofImageDataUrl || pixCharges.find((c) => c.saleId === s.id)?.proofImageDataUrl) ? (
                        <button
                          type="button"
                          className="btn-proof"
                          title="Abrir comprovante"
                          onClick={() =>
                            openProof(
                              s.proofImageDataUrl ||
                                pixCharges.find((c) => c.saleId === s.id)?.proofImageDataUrl ||
                                '',
                            )
                          }
                        >
                          <ProofIcon />
                        </button>
                      ) : (
                        '—'
                      )}
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
        <section className="reports-stack">
          <div className="panel">
            <div className="panel-head">
              <div>
                <h2>Prestações / fechamentos com membros</h2>
                <p>Registros de “Receber dinheiro” e “Receber PIX vendedor” feitos em Relatórios.</p>
              </div>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Quando</th>
                    <th>Membro</th>
                    <th>Tipo</th>
                    <th>Valor</th>
                    <th>Obs.</th>
                  </tr>
                </thead>
                <tbody>
                  {memberSettlements.length === 0 && (
                    <tr>
                      <td colSpan={5}>
                        <p className="empty">Nenhuma prestação registrada ainda.</p>
                      </td>
                    </tr>
                  )}
                  {memberSettlements.map((row) => (
                    <tr key={row.id}>
                      <td>{new Date(row.createdAt).toLocaleString('pt-BR')}</td>
                      <td>{members.find((m) => m.id === row.memberId)?.name || '—'}</td>
                      <td>{row.kind === 'dinheiro' ? 'Dinheiro' : 'PIX vendedor'}</td>
                      <td>{brl(row.amount)}</td>
                      <td>{row.note || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="panel">
            <div className="panel-head">
              <div>
                <h2>Baixas de PIX (amortização por venda)</h2>
                <p>Quando um PIX do extrato/CSV é aplicado em uma venda específica.</p>
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
                  {amortizations.length === 0 && (
                    <tr>
                      <td colSpan={4}>
                        <p className="empty">Nenhuma amortização de PIX ainda.</p>
                      </td>
                    </tr>
                  )}
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
          </div>
        </section>
      )}

      {isAdmin && adminTab === 'relatorios' && (
        <section className="reports-stack">
          <div className="panel">
            <div className="panel-head">
              <div>
                <h2>Relatórios analíticos</h2>
                <p>Visão financeira, vendas com comprovante e rastro de transferências.</p>
              </div>
            </div>
            <div className="report-tabs">
              {(
                [
                  ['prestacao', 'Prestação / blocos'],
                  ['vendas', 'Vendas detalhadas'],
                  ['transferencias', 'Transferências entre membros'],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={reportSection === id ? 'active' : ''}
                  onClick={() => setReportSection(id)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="hero-metrics report-metrics">
              <article className="metric">
                <span>Esperado</span>
                <strong>{brl(totals.expected)}</strong>
              </article>
              <article className="metric">
                <span>Recebido</span>
                <strong>{brl(totals.received)}</strong>
              </article>
              <article className="metric">
                <span>Dinheiro loja</span>
                <strong>{brl(totals.cashLoja)}</strong>
              </article>
              <article className="metric">
                <span>Dinheiro c/ vendedor</span>
                <strong>{brl(totals.cashVendedorOpen)}</strong>
              </article>
              <article className="metric">
                <span>PIX entidade</span>
                <strong>{brl(totals.pixEntidade)}</strong>
              </article>
              <article className="metric">
                <span>PIX vendedor aberto</span>
                <strong>{brl(totals.pixVendedorOpen)}</strong>
              </article>
            </div>
          </div>

          {reportSection === 'prestacao' && (
            <div className="panel">
              <div className="panel-head">
                <div>
                  <h2>Prestação por membro</h2>
                  <p>Blocos em aberto, dinheiro com o vendedor e PIX a repassar.</p>
                </div>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Membro</th>
                      <th>Blocos</th>
                      <th>Com aberto</th>
                      <th>Esgotados</th>
                      <th>Nº abertos</th>
                      <th>Nº vendidos</th>
                      <th>Dinheiro loja</th>
                      <th>Dinheiro c/ ele</th>
                      <th>PIX vendedor aberto</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...reports]
                      .sort((a, b) => memberBlockStats(b.member.id).openNumbers - memberBlockStats(a.member.id).openNumbers)
                      .map((r) => {
                        const bs = memberBlockStats(r.member.id)
                        return (
                          <tr key={r.member.id}>
                            <td>{r.member.name}</td>
                            <td>{bs.blocks}</td>
                            <td>{bs.openBlocks}</td>
                            <td>{bs.soldOutBlocks}</td>
                            <td>{bs.openNumbers}</td>
                            <td>{bs.soldNumbers}</td>
                            <td>{brl(r.cashLoja)}</td>
                            <td>{brl(r.cashOpen)}</td>
                            <td>{brl(r.pixVendedorOpen)}</td>
                            <td>
                              {r.cashOpen > 0 && (
                                <button
                                  type="button"
                                  className="btn btn-secondary"
                                  onClick={() => {
                                    addMemberSettlement({
                                      memberId: r.member.id,
                                      amount: r.cashOpen,
                                      kind: 'dinheiro',
                                      note: 'Prestação dinheiro',
                                    })
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
                        )
                      })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {reportSection === 'vendas' && (
            <div className="panel">
              <div className="panel-head">
                <div>
                  <h2>Vendas detalhadas</h2>
                  <p>Recebimento, destino do dinheiro e comprovante anexado.</p>
                </div>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Data</th>
                      <th>Membro</th>
                      <th>Comprador</th>
                      <th>Números</th>
                      <th>Valor</th>
                      <th>Forma</th>
                      <th>Dinheiro loja</th>
                      <th>Status</th>
                      <th>Comprovante</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...sales]
                      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                      .map((s) => {
                        const proof =
                          s.proofImageDataUrl || pixCharges.find((c) => c.saleId === s.id)?.proofImageDataUrl
                        const loja =
                          s.paymentMethod === 'dinheiro' && s.cashDestination === 'loja' ? s.paidAmount : 0
                        return (
                          <tr key={s.id}>
                            <td>{new Date(s.createdAt).toLocaleString('pt-BR')}</td>
                            <td>{members.find((m) => m.id === s.memberId)?.name || '—'}</td>
                            <td>{s.buyerName}</td>
                            <td>{formatNumbers(s.numbers)}</td>
                            <td>
                              {brl(s.paidAmount)}/{brl(s.totalAmount)}
                            </td>
                            <td>
                              {s.paymentMethod === 'dinheiro'
                                ? `Dinheiro (${s.cashDestination === 'loja' ? 'loja' : 'vendedor'})`
                                : `PIX/${s.pixDestination || '—'}`}
                            </td>
                            <td>{brl(loja)}</td>
                            <td>
                              <span className={`badge ${s.status}`}>{statusLabel[s.status]}</span>
                            </td>
                            <td>
                              {proof ? (
                                <button
                                  type="button"
                                  className="btn-proof"
                                  title="Abrir comprovante"
                                  onClick={() => openProof(proof)}
                                >
                                  <ProofIcon />
                                </button>
                              ) : (
                                '—'
                              )}
                            </td>
                          </tr>
                        )
                      })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {reportSection === 'transferencias' && (
            <div className="panel">
              <div className="panel-head">
                <div>
                  <h2>Transferências entre membros</h2>
                  <p>Histórico completo de atribuições, transferências e liberações de blocos.</p>
                </div>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Quando</th>
                      <th>Tipo</th>
                      <th>Evento</th>
                      <th>Bloco</th>
                      <th>De</th>
                      <th>Para</th>
                      <th>Obs.</th>
                    </tr>
                  </thead>
                  <tbody>
                    {blockTransfers.map((t) => {
                      const block = blocks.find((b) => b.id === t.blockId)
                      const raffle = raffles.find((r) => r.id === t.raffleId)
                      const kindLabel =
                        t.kind === 'assign' ? 'Atribuição' : t.kind === 'transfer' ? 'Transferência' : 'Liberação'
                      return (
                        <tr key={t.id}>
                          <td>{new Date(t.createdAt).toLocaleString('pt-BR')}</td>
                          <td>{kindLabel}</td>
                          <td>{raffle?.eventName || '—'}</td>
                          <td>
                            {block?.label || '—'}
                            {block ? ` (${block.fromNumber}–${block.toNumber})` : ''}
                          </td>
                          <td>{t.fromMemberId ? members.find((m) => m.id === t.fromMemberId)?.name || '—' : 'livre'}</td>
                          <td>{t.toMemberId ? members.find((m) => m.id === t.toMemberId)?.name || '—' : 'livre'}</td>
                          <td>{t.note || '—'}</td>
                        </tr>
                      )
                    })}
                    {blockTransfers.length === 0 && (
                      <tr>
                        <td colSpan={7}>
                          <p className="empty">Nenhuma transferência registrada.</p>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>
      )}

      {toast && <div className="toast">{toast}</div>}
      <TeamChat />
    </div>
  )
}
