import { useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { getAuthRecord, getSession, logout } from './auth'
import { parsePixCsv, SAMPLE_CSV } from './csvImport'
import { NumberGrid } from './NumberGrid'
import { isSupabaseConfigured, supabase } from './lib/supabase'
import { openProofUrl, resolveProofUrl, uploadProofFile } from './lib/proofs'
import { loadCloudSession, saveCloudSession } from './lib/workspace'
import { brl, formatNumbers, useStore } from './store'
import { TeamChat } from './TeamChat'
import { InstallAppButton } from './InstallAppButton'
import { previewTxidMatches } from './txidMatch'
import type { CashDestination, PaymentMethod, PaymentStatus, PixDestination } from './types'

type AdminTab = 'painel' | 'equipe' | 'transferencias' | 'eventos' | 'vendas' | 'pix' | 'txid' | 'amortizacao' | 'relatorios'
type MemberTab = 'blocos' | 'vendas'

const statusLabel: Record<PaymentStatus, string> = {
  pendente: 'Pendente',
  parcial: 'Parcial',
  quitado: 'Quitado',
  divergente: 'Divergente',
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

async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(new Error('Falha ao ler arquivo'))
    reader.readAsDataURL(file)
  })
}

function proofUrlForSale(
  sale: { id: string; proofPath?: string; proofImageDataUrl?: string },
  charges: Array<{ saleId: string; proofImageDataUrl?: string }>,
) {
  const fromSale = resolveProofUrl(sale)
  if (fromSale) return fromSale
  return charges.find((c) => c.saleId === sale.id)?.proofImageDataUrl || ''
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
  const [reportMemberId, setReportMemberId] = useState('')
  const [reportEventId, setReportEventId] = useState('')
  const [reportDetail, setReportDetail] = useState<'resumo' | 'vendas' | 'blocos' | 'baixas' | 'movimentos'>('resumo')
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
    return members
      .filter((m) => m.active)
      .map((m) => {
        const mSalesAll = sales.filter((s) => s.memberId === m.id)
        const mSales = reportEventId ? mSalesAll.filter((s) => s.raffleId === reportEventId) : mSalesAll
        const soldCount = mSales.reduce((acc, s) => acc + s.numbers.length, 0)
        const saleCount = mSales.length
        const expected = mSales.reduce((acc, s) => acc + s.totalAmount, 0)
        const received = mSales.reduce((acc, s) => acc + s.paidAmount, 0)
        const openAmount = Math.max(0, expected - received)
        const cashVendedor = mSales
          .filter((s) => s.paymentMethod === 'dinheiro' && (s.cashDestination || 'vendedor') === 'vendedor')
          .reduce((acc, s) => acc + s.paidAmount, 0)
        const cashLoja = mSales
          .filter((s) => s.paymentMethod === 'dinheiro' && s.cashDestination === 'loja')
          .reduce((acc, s) => acc + s.paidAmount, 0)
        const pixEntidade = mSales
          .filter((s) => s.paymentMethod === 'pix' && s.pixDestination === 'entidade')
          .reduce((acc, s) => acc + s.paidAmount, 0)
        const pixVendedor = mSales
          .filter((s) => s.paymentMethod === 'pix' && s.pixDestination === 'vendedor')
          .reduce((acc, s) => acc + s.paidAmount, 0)
        const settlements = memberSettlements.filter((x) => x.memberId === m.id)
        const settledCash = settlements.filter((x) => x.kind === 'dinheiro').reduce((a, x) => a + x.amount, 0)
        const settledPix = settlements.filter((x) => x.kind === 'pix_vendedor').reduce((a, x) => a + x.amount, 0)
        const byStatus = {
          quitado: mSales.filter((s) => s.status === 'quitado').length,
          pendente: mSales.filter((s) => s.status === 'pendente').length,
          parcial: mSales.filter((s) => s.status === 'parcial').length,
          divergente: mSales.filter((s) => s.status === 'divergente').length,
        }
        const withProof = mSales.filter((s) => Boolean(proofUrlForSale(s, pixCharges))).length
        // Prestações são globais; com filtro de evento mostramos o bruto do período
        const cashOpen = reportEventId ? cashVendedor : Math.max(0, cashVendedor - settledCash)
        const pixVendedorOpen = reportEventId ? pixVendedor : Math.max(0, pixVendedor - settledPix)
        const toEntity = cashLoja + pixEntidade + (reportEventId ? 0 : settledCash + settledPix)
        return {
          member: m,
          mSales,
          settlements,
          saleCount,
          soldCount,
          expected,
          received,
          openAmount,
          cashVendedor,
          cashLoja,
          pixEntidade,
          pixVendedor,
          settledCash,
          settledPix,
          cashOpen,
          pixVendedorOpen,
          toEntity,
          byStatus,
          withProof,
          dueTotal: cashOpen + pixVendedorOpen,
        }
      })
      .sort((a, b) => b.dueTotal - a.dueTotal || b.expected - a.expected || a.member.name.localeCompare(b.member.name))
  }, [members, sales, memberSettlements, reportEventId, pixCharges])

  const totals = useMemo(() => {
    return reports.reduce(
      (acc, r) => ({
        expected: acc.expected + r.expected,
        received: acc.received + r.received,
        cashLoja: acc.cashLoja + r.cashLoja,
        cashVendedorOpen: acc.cashVendedorOpen + r.cashOpen,
        pixEntidade: acc.pixEntidade + r.pixEntidade,
        pixVendedorOpen: acc.pixVendedorOpen + r.pixVendedorOpen,
        soldCount: acc.soldCount + r.soldCount,
        saleCount: acc.saleCount + r.saleCount,
        dueTotal: acc.dueTotal + r.dueTotal,
      }),
      {
        expected: 0,
        received: 0,
        cashLoja: 0,
        cashVendedorOpen: 0,
        pixEntidade: 0,
        pixVendedorOpen: 0,
        soldCount: 0,
        saleCount: 0,
        dueTotal: 0,
      },
    )
  }, [reports])

  const selectedReport = useMemo(
    () => reports.find((r) => r.member.id === reportMemberId) || null,
    [reports, reportMemberId],
  )

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
    const file = (e.currentTarget.elements.namedItem('proofFile') as HTMLInputElement | null)?.files?.[0]
    const cloudReady = isSupabaseConfigured && Boolean(loadCloudSession()?.workspace.id)

    let proofPath: string | undefined
    let proofImageDataUrl: string | undefined
    if (file) {
      try {
        if (cloudReady) {
          const up = await uploadProofFile(crypto.randomUUID(), file)
          proofPath = up.path
        } else {
          proofImageDataUrl = proofDataUrl || (await fileToDataUrl(file))
        }
      } catch (err) {
        return showToast(err instanceof Error ? err.message : 'Não foi possível enviar o comprovante.')
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
      proofPath,
      proofImageDataUrl,
      receivedNow: paymentMethod === 'dinheiro' || String(fd.get('receivedNow') || '') === 'sim',
      blockId: openBlockId || undefined,
    })
    if (!result.ok) return showToast(result.error)
    e.currentTarget.reset()
    setSelectedNumbers([])
    setPaymentMethod('dinheiro')
    setCashDestination('vendedor')
    setProofDataUrl('')
    showToast(proofPath ? 'Venda registrada (comprovante na nuvem).' : 'Venda registrada.')
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
          <InstallAppButton />
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
                        {proofUrlForSale(s, pixCharges) && (
                          <>
                            {' · '}
                            <button
                              type="button"
                              className="btn-proof"
                              title="Abrir comprovante"
                              onClick={() => openProofUrl(proofUrlForSale(s, pixCharges))}
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
                      {proofUrlForSale(s, pixCharges) ? (
                        <button
                          type="button"
                          className="btn-proof"
                          title="Abrir comprovante"
                          onClick={() => openProofUrl(proofUrlForSale(s, pixCharges))}
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
                <h2>Relatórios por membro</h2>
                <p>Um membro por vez — financeiro, vendas, blocos e baixas sem misturar a equipe.</p>
              </div>
            </div>
            <div className="form-grid report-filters">
              <label>
                Evento
                <select
                  value={reportEventId}
                  onChange={(e) => {
                    setReportEventId(e.target.value)
                  }}
                >
                  <option value="">Todos os eventos</option>
                  {raffles.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.eventName || r.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Membro
                <select
                  value={reportMemberId}
                  onChange={(e) => {
                    setReportMemberId(e.target.value)
                    setReportDetail('resumo')
                  }}
                >
                  <option value="">Ver ranking da equipe</option>
                  {reports.map((r) => (
                    <option key={r.member.id} value={r.member.id}>
                      {r.member.name}
                      {r.dueTotal > 0 ? ` · a prestar ${brl(r.dueTotal)}` : ''}
                    </option>
                  ))}
                </select>
              </label>
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
                <span>A prestar (equipe)</span>
                <strong>{brl(totals.dueTotal)}</strong>
              </article>
              <article className="metric">
                <span>Dinheiro loja</span>
                <strong>{brl(totals.cashLoja)}</strong>
              </article>
              <article className="metric">
                <span>PIX entidade</span>
                <strong>{brl(totals.pixEntidade)}</strong>
              </article>
              <article className="metric">
                <span>Números vendidos</span>
                <strong>{totals.soldCount}</strong>
              </article>
            </div>
          </div>

          {!selectedReport && (
            <div className="panel">
              <div className="panel-head">
                <div>
                  <h2>Equipe</h2>
                  <p>Toque no membro para abrir o dossiê completo. Ordenado por valor a prestar.</p>
                </div>
              </div>
              <div className="member-report-list">
                {reports.map((r) => {
                  const bs = memberBlockStats(r.member.id, reportEventId || undefined)
                  return (
                    <button
                      key={r.member.id}
                      type="button"
                      className="member-report-row"
                      onClick={() => {
                        setReportMemberId(r.member.id)
                        setReportDetail('resumo')
                      }}
                    >
                      <div className="member-report-main">
                        <strong>{r.member.name}</strong>
                        <span className="hint">
                          {r.saleCount} vendas · {r.soldCount} nº · {bs.blocks} blocos
                          {bs.openNumbers > 0 ? ` · ${bs.openNumbers} abertos` : ''}
                        </span>
                      </div>
                      <div className="member-report-kpis">
                        <span>
                          Esperado
                          <strong>{brl(r.expected)}</strong>
                        </span>
                        <span>
                          Recebido
                          <strong>{brl(r.received)}</strong>
                        </span>
                        <span className={r.dueTotal > 0 ? 'due' : 'ok'}>
                          A prestar
                          <strong>{brl(r.dueTotal)}</strong>
                        </span>
                      </div>
                    </button>
                  )
                })}
                {reports.length === 0 && <p className="empty">Nenhum membro ativo.</p>}
              </div>
            </div>
          )}

          {selectedReport && (
            <div className="panel member-dossier">
              <div className="panel-head">
                <div>
                  <button type="button" className="linkish" onClick={() => setReportMemberId('')}>
                    ← Voltar à equipe
                  </button>
                  <h2>{selectedReport.member.name}</h2>
                  <p>
                    Dossiê individual
                    {reportEventId
                      ? ` · ${raffles.find((r) => r.id === reportEventId)?.eventName || 'evento'}`
                      : ' · todos os eventos'}
                    .
                  </p>
                </div>
                <div className="btn-row wrap">
                  {selectedReport.cashOpen > 0 && (
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => {
                        addMemberSettlement({
                          memberId: selectedReport.member.id,
                          amount: selectedReport.cashOpen,
                          kind: 'dinheiro',
                          note: 'Prestação dinheiro',
                          raffleId: reportEventId || undefined,
                        })
                        showToast('Dinheiro quitado com a entidade.')
                      }}
                    >
                      Receber dinheiro {brl(selectedReport.cashOpen)}
                    </button>
                  )}
                  {selectedReport.pixVendedorOpen > 0 && (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => {
                        addMemberSettlement({
                          memberId: selectedReport.member.id,
                          amount: selectedReport.pixVendedorOpen,
                          kind: 'pix_vendedor',
                          note: 'Repasse PIX vendedor',
                          raffleId: reportEventId || undefined,
                        })
                        showToast('PIX do vendedor prestado.')
                      }}
                    >
                      Receber PIX {brl(selectedReport.pixVendedorOpen)}
                    </button>
                  )}
                </div>
              </div>

              <div className="report-tabs">
                {(
                  [
                    ['resumo', 'Resumo'],
                    ['vendas', 'Vendas'],
                    ['blocos', 'Blocos'],
                    ['baixas', 'Baixas / prestações'],
                    ['movimentos', 'Movimentos de bloco'],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    className={reportDetail === id ? 'active' : ''}
                    onClick={() => setReportDetail(id)}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {reportDetail === 'resumo' && (
                <div className="dossier-body">
                  <div className="hero-metrics report-metrics">
                    <article className="metric">
                      <span>Esperado</span>
                      <strong>{brl(selectedReport.expected)}</strong>
                    </article>
                    <article className="metric">
                      <span>Recebido</span>
                      <strong>{brl(selectedReport.received)}</strong>
                    </article>
                    <article className="metric">
                      <span>Em aberto (vendas)</span>
                      <strong>{brl(selectedReport.openAmount)}</strong>
                    </article>
                    <article className="metric due-metric">
                      <span>A prestar à entidade</span>
                      <strong>{brl(selectedReport.dueTotal)}</strong>
                    </article>
                  </div>

                  <div className="breakdown-grid">
                    <article>
                      <h3>Origem do dinheiro</h3>
                      <ul className="breakdown-list">
                        <li>
                          <span>Dinheiro já na loja</span>
                          <strong>{brl(selectedReport.cashLoja)}</strong>
                        </li>
                        <li>
                          <span>Dinheiro ainda com o vendedor</span>
                          <strong>{brl(selectedReport.cashVendedor)}</strong>
                        </li>
                        <li>
                          <span>Já prestado (dinheiro)</span>
                          <strong>{brl(selectedReport.settledCash)}</strong>
                        </li>
                        <li className={selectedReport.cashOpen > 0 ? 'warn' : ''}>
                          <span>Dinheiro a receber dele</span>
                          <strong>{brl(selectedReport.cashOpen)}</strong>
                        </li>
                      </ul>
                    </article>
                    <article>
                      <h3>PIX</h3>
                      <ul className="breakdown-list">
                        <li>
                          <span>PIX direto na entidade</span>
                          <strong>{brl(selectedReport.pixEntidade)}</strong>
                        </li>
                        <li>
                          <span>PIX na conta do vendedor</span>
                          <strong>{brl(selectedReport.pixVendedor)}</strong>
                        </li>
                        <li>
                          <span>Já prestado (PIX vendedor)</span>
                          <strong>{brl(selectedReport.settledPix)}</strong>
                        </li>
                        <li className={selectedReport.pixVendedorOpen > 0 ? 'warn' : ''}>
                          <span>PIX a receber dele</span>
                          <strong>{brl(selectedReport.pixVendedorOpen)}</strong>
                        </li>
                      </ul>
                    </article>
                    <article>
                      <h3>Vendas</h3>
                      <ul className="breakdown-list">
                        <li>
                          <span>Qtd. de vendas</span>
                          <strong>{selectedReport.saleCount}</strong>
                        </li>
                        <li>
                          <span>Números vendidos</span>
                          <strong>{selectedReport.soldCount}</strong>
                        </li>
                        <li>
                          <span>Com comprovante</span>
                          <strong>
                            {selectedReport.withProof}/{selectedReport.saleCount}
                          </strong>
                        </li>
                        <li>
                          <span>Já na entidade (loja+PIX+prestado)</span>
                          <strong>{brl(selectedReport.toEntity)}</strong>
                        </li>
                      </ul>
                    </article>
                    <article>
                      <h3>Status das vendas</h3>
                      <ul className="breakdown-list">
                        <li>
                          <span>Quitado</span>
                          <strong>{selectedReport.byStatus.quitado}</strong>
                        </li>
                        <li>
                          <span>Pendente</span>
                          <strong>{selectedReport.byStatus.pendente}</strong>
                        </li>
                        <li>
                          <span>Parcial</span>
                          <strong>{selectedReport.byStatus.parcial}</strong>
                        </li>
                        <li>
                          <span>Divergente</span>
                          <strong>{selectedReport.byStatus.divergente}</strong>
                        </li>
                      </ul>
                    </article>
                  </div>

                  {(() => {
                    const bs = memberBlockStats(selectedReport.member.id, reportEventId || undefined)
                    return (
                      <div className="hint dossier-hint">
                        Blocos: {bs.blocks} · com aberto {bs.openBlocks} · esgotados {bs.soldOutBlocks} · nº
                        abertos {bs.openNumbers} · nº vendidos nos blocos {bs.soldNumbers}
                        {reportEventId
                          ? ' · Prestações são globais; o filtro de evento afeta vendas e blocos.'
                          : ''}
                      </div>
                    )
                  })()}
                </div>
              )}

              {reportDetail === 'vendas' && (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Data</th>
                        <th>Evento</th>
                        <th>Comprador</th>
                        <th>Números</th>
                        <th>Valor</th>
                        <th>Forma</th>
                        <th>Status</th>
                        <th>Comprovante</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...selectedReport.mSales]
                        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                        .map((s) => {
                          const proof = proofUrlForSale(s, pixCharges)
                          const raffle = raffles.find((r) => r.id === s.raffleId)
                          return (
                            <tr key={s.id}>
                              <td>{new Date(s.createdAt).toLocaleString('pt-BR')}</td>
                              <td>{raffle?.eventName || raffle?.name || '—'}</td>
                              <td>
                                {s.buyerName}
                                {s.buyerPhone ? <div className="hint">{s.buyerPhone}</div> : null}
                              </td>
                              <td>{formatNumbers(s.numbers)}</td>
                              <td>
                                {brl(s.paidAmount)}/{brl(s.totalAmount)}
                              </td>
                              <td>
                                {s.paymentMethod === 'dinheiro'
                                  ? `Dinheiro (${s.cashDestination === 'loja' ? 'loja' : 'vendedor'})`
                                  : `PIX/${s.pixDestination || '—'}`}
                              </td>
                              <td>
                                <span className={`badge ${s.status}`}>{statusLabel[s.status]}</span>
                              </td>
                              <td>
                                {proof ? (
                                  <button
                                    type="button"
                                    className="btn-proof"
                                    title="Abrir comprovante"
                                    onClick={() => openProofUrl(proof)}
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
                      {selectedReport.mSales.length === 0 && (
                        <tr>
                          <td colSpan={8}>
                            <p className="empty">Nenhuma venda deste membro no filtro.</p>
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}

              {reportDetail === 'blocos' && (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Evento</th>
                        <th>Bloco</th>
                        <th>Faixa</th>
                        <th>Total</th>
                        <th>Vendidos</th>
                        <th>Abertos</th>
                      </tr>
                    </thead>
                    <tbody>
                      {blocks
                        .filter(
                          (b) =>
                            b.memberId === selectedReport.member.id &&
                            (!reportEventId || b.raffleId === reportEventId),
                        )
                        .sort((a, b) => a.index - b.index)
                        .map((b) => {
                          const st = blockStats(b.id)
                          const raffle = raffles.find((r) => r.id === b.raffleId)
                          return (
                            <tr key={b.id}>
                              <td>{raffle?.eventName || raffle?.name || '—'}</td>
                              <td>{b.label}</td>
                              <td>
                                {b.fromNumber}–{b.toNumber}
                              </td>
                              <td>{st.total}</td>
                              <td>{st.sold}</td>
                              <td>{st.open}</td>
                            </tr>
                          )
                        })}
                      {blocks.filter(
                        (b) =>
                          b.memberId === selectedReport.member.id &&
                          (!reportEventId || b.raffleId === reportEventId),
                      ).length === 0 && (
                        <tr>
                          <td colSpan={6}>
                            <p className="empty">Nenhum bloco com este membro.</p>
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}

              {reportDetail === 'baixas' && (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Quando</th>
                        <th>Tipo</th>
                        <th>Valor</th>
                        <th>Obs.</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selectedReport.settlements.map((x) => (
                        <tr key={x.id}>
                          <td>{new Date(x.createdAt).toLocaleString('pt-BR')}</td>
                          <td>{x.kind === 'dinheiro' ? 'Dinheiro' : 'PIX vendedor'}</td>
                          <td>{brl(x.amount)}</td>
                          <td>{x.note || '—'}</td>
                        </tr>
                      ))}
                      {selectedReport.settlements.length === 0 && (
                        <tr>
                          <td colSpan={4}>
                            <p className="empty">Nenhuma prestação registrada deste membro.</p>
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}

              {reportDetail === 'movimentos' && (
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
                      {blockTransfers
                        .filter(
                          (t) =>
                            t.fromMemberId === selectedReport.member.id ||
                            t.toMemberId === selectedReport.member.id,
                        )
                        .filter((t) => !reportEventId || t.raffleId === reportEventId)
                        .map((t) => {
                          const block = blocks.find((b) => b.id === t.blockId)
                          const raffle = raffles.find((r) => r.id === t.raffleId)
                          const kindLabel =
                            t.kind === 'assign'
                              ? 'Atribuição'
                              : t.kind === 'transfer'
                                ? 'Transferência'
                                : 'Liberação'
                          return (
                            <tr key={t.id}>
                              <td>{new Date(t.createdAt).toLocaleString('pt-BR')}</td>
                              <td>{kindLabel}</td>
                              <td>{raffle?.eventName || '—'}</td>
                              <td>
                                {block?.label || '—'}
                                {block ? ` (${block.fromNumber}–${block.toNumber})` : ''}
                              </td>
                              <td>
                                {t.fromMemberId
                                  ? members.find((m) => m.id === t.fromMemberId)?.name || '—'
                                  : 'livre'}
                              </td>
                              <td>
                                {t.toMemberId
                                  ? members.find((m) => m.id === t.toMemberId)?.name || '—'
                                  : 'livre'}
                              </td>
                              <td>{t.note || '—'}</td>
                            </tr>
                          )
                        })}
                      {blockTransfers.filter(
                        (t) =>
                          (t.fromMemberId === selectedReport.member.id ||
                            t.toMemberId === selectedReport.member.id) &&
                          (!reportEventId || t.raffleId === reportEventId),
                      ).length === 0 && (
                        <tr>
                          <td colSpan={7}>
                            <p className="empty">Nenhum movimento de bloco deste membro.</p>
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {toast && <div className="toast">{toast}</div>}
      <TeamChat />
    </div>
  )
}
