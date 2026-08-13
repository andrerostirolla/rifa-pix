import type { AppState, Sale } from '../types'
import { isSupabaseConfigured, supabase } from './supabase'
import { loadCloudSession } from './workspace'

const BUCKET = 'comprovantes'

export function proofPublicUrl(path: string) {
  if (!supabase) return path
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path)
  return data.publicUrl
}

export function resolveProofUrl(sale: Pick<Sale, 'proofPath' | 'proofImageDataUrl'> & { id?: string }) {
  if (sale.proofPath && isSupabaseConfigured) return proofPublicUrl(sale.proofPath)
  return sale.proofImageDataUrl || ''
}

function extFromMime(mime: string) {
  if (mime.includes('pdf')) return 'pdf'
  if (mime.includes('png')) return 'png'
  if (mime.includes('webp')) return 'webp'
  if (mime.includes('gif')) return 'gif'
  return 'jpg'
}

export function dataUrlToBlob(dataUrl: string): { blob: Blob; mime: string; ext: string } {
  const [header, b64] = dataUrl.split(',')
  if (!b64) throw new Error('Comprovante inválido')
  const mime = header.match(/data:([^;]+)/)?.[1] || 'application/octet-stream'
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i)
  return { blob: new Blob([bytes], { type: mime }), mime, ext: extFromMime(mime) }
}

function workspaceIdOrThrow() {
  const id = loadCloudSession()?.workspace.id
  if (!id) throw new Error('Workspace não disponível para upload')
  return id
}

export async function uploadProofBlob(input: {
  saleId: string
  blob: Blob
  mime?: string
  workspaceId?: string
}): Promise<{ path: string; publicUrl: string }> {
  if (!supabase || !isSupabaseConfigured) throw new Error('Supabase não configurado')
  const ws = input.workspaceId || workspaceIdOrThrow()
  const mime = input.mime || input.blob.type || 'application/octet-stream'
  const ext = extFromMime(mime)
  const path = `${ws}/${input.saleId}/${Date.now()}.${ext}`
  const { error } = await supabase.storage.from(BUCKET).upload(path, input.blob, {
    contentType: mime,
    upsert: true,
  })
  if (error) throw error
  return { path, publicUrl: proofPublicUrl(path) }
}

export async function uploadProofFile(saleId: string, file: File, workspaceId?: string) {
  return uploadProofBlob({ saleId, blob: file, mime: file.type, workspaceId })
}

export async function uploadProofDataUrl(saleId: string, dataUrl: string, workspaceId?: string) {
  const { blob, mime } = dataUrlToBlob(dataUrl)
  return uploadProofBlob({ saleId, blob, mime, workspaceId })
}

/** Move data URLs embutidas para o Storage e limpa o JSON. */
export async function offloadEmbeddedProofs(
  state: AppState,
  workspaceId?: string,
): Promise<{ state: AppState; moved: number; errors: string[] }> {
  if (!supabase || !isSupabaseConfigured) return { state, moved: 0, errors: [] }
  const ws = workspaceId || loadCloudSession()?.workspace.id
  if (!ws) return { state, moved: 0, errors: [] }

  let moved = 0
  const errors: string[] = []
  const sales: Sale[] = []

  for (const sale of state.sales || []) {
    if (sale.proofPath || !sale.proofImageDataUrl?.startsWith('data:')) {
      // já no storage, ou sem comprovante — remove data URL órfã se tiver path
      if (sale.proofPath && sale.proofImageDataUrl) {
        sales.push({ ...sale, proofImageDataUrl: undefined })
        moved += 1
      } else {
        sales.push(sale)
      }
      continue
    }
    try {
      const up = await uploadProofDataUrl(sale.id, sale.proofImageDataUrl, ws)
      sales.push({
        ...sale,
        proofPath: up.path,
        proofImageDataUrl: undefined,
      })
      moved += 1
    } catch (err) {
      errors.push(`${sale.id}: ${err instanceof Error ? err.message : 'falha upload'}`)
      sales.push(sale)
    }
  }

  // Charges com data URL: sobe na venda se ainda não tiver path; senão só limpa
  const salesById = new Map(sales.map((s) => [s.id, s]))
  const pixCharges = []
  for (const c of state.pixCharges || []) {
    if (!c.proofImageDataUrl?.startsWith('data:')) {
      pixCharges.push(c)
      continue
    }
    const sale = salesById.get(c.saleId)
    if (sale?.proofPath) {
      moved += 1
      pixCharges.push({ ...c, proofImageDataUrl: undefined })
      continue
    }
    try {
      const up = await uploadProofDataUrl(c.saleId || c.id, c.proofImageDataUrl, ws)
      if (sale) {
        const nextSale = { ...sale, proofPath: up.path, proofImageDataUrl: undefined }
        salesById.set(sale.id, nextSale)
        const idx = sales.findIndex((s) => s.id === sale.id)
        if (idx >= 0) sales[idx] = nextSale
      }
      moved += 1
      pixCharges.push({ ...c, proofImageDataUrl: undefined })
    } catch (err) {
      errors.push(`charge ${c.id}: ${err instanceof Error ? err.message : 'falha upload'}`)
      pixCharges.push(c)
    }
  }

  return {
    state: { ...state, sales, pixCharges },
    moved,
    errors,
  }
}

export function openProofUrl(url: string) {
  if (!url) return
  if (url.startsWith('data:')) {
    try {
      const { blob } = dataUrlToBlob(url)
      const obj = URL.createObjectURL(blob)
      window.open(obj, '_blank', 'noopener,noreferrer')
      return
    } catch {
      window.open(url, '_blank', 'noopener,noreferrer')
      return
    }
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}
