/** EMV QR / PIX copia-e-cola (CRC-16-CCITT-FALSE, tag 63). */

function tlv(id: string, value: string): string {
  const len = value.length.toString().padStart(2, '0')
  return `${id}${len}${value}`
}

export function crc16Ccitt(payload: string): string {
  let crc = 0xffff
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8
    for (let j = 0; j < 8; j++) {
      if (crc & 0x8000) crc = ((crc << 1) ^ 0x1021) & 0xffff
      else crc = (crc << 1) & 0xffff
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0')
}

export function buildPixCopiaECola(opts: {
  pixKey: string
  amount: number
  merchantName?: string
  city?: string
  txid?: string
}): string {
  const key = opts.pixKey.trim()
  const merchantAccount = tlv('00', 'BR.GOV.BCB.PIX') + tlv('01', key)
  const amountStr = opts.amount.toFixed(2)
  const name = (opts.merchantName || 'RIFAPIX').slice(0, 25).toUpperCase()
  const city = (opts.city || 'SAO PAULO').slice(0, 15).toUpperCase()

  let payload = ''
  payload += tlv('00', '01')
  payload += tlv('26', merchantAccount)
  payload += tlv('52', '0000')
  payload += tlv('53', '986')
  payload += tlv('54', amountStr)
  payload += tlv('58', 'BR')
  payload += tlv('59', name)
  payload += tlv('60', city)
  if (opts.txid?.trim()) {
    payload += tlv('62', tlv('05', opts.txid.trim().slice(0, 25)))
  }

  const withCrcTag = `${payload}6304`
  return withCrcTag + crc16Ccitt(withCrcTag)
}

/** Demo local — CRC válido, mas só paga com PIX real do Sicoob. */
export function buildMockPixCopiaECola(amount: number, txid: string, pixKey?: string): string {
  return buildPixCopiaECola({
    pixKey: pixKey || '00000000000',
    amount,
    merchantName: 'RIFAPIX DEMO',
    city: 'SAO PAULO',
    txid,
  })
}
