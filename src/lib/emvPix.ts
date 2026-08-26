/** EMV PIX copia-e-cola (mesma lógica das Edge Functions). */

function tlv(id: string, value: string): string {
  const len = value.length.toString().padStart(2, '0')
  return `${id}${len}${value}`
}

function crc16Ccitt(payload: string): string {
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

export function buildMockPixCopiaECola(amount: number, txid: string, pixKey = '00000000000'): string {
  const merchantAccount = tlv('00', 'BR.GOV.BCB.PIX') + tlv('01', pixKey)
  const amountStr = amount.toFixed(2)

  let payload = ''
  payload += tlv('00', '01')
  payload += tlv('26', merchantAccount)
  payload += tlv('52', '0000')
  payload += tlv('53', '986')
  payload += tlv('54', amountStr)
  payload += tlv('58', 'BR')
  payload += tlv('59', 'RIFAPIX DEMO')
  payload += tlv('60', 'SAO PAULO')
  payload += tlv('62', tlv('05', txid.slice(0, 25)))

  const withCrcTag = `${payload}6304`
  return withCrcTag + crc16Ccitt(withCrcTag)
}
