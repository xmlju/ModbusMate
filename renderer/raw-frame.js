// renderer/raw-frame.js — 自由报文的十六进制与 CRC16 工具
(function (root, factory) {
  const api = factory()
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  root.RawFrame = api
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  function parseHex(value) {
    const text = String(value ?? '').replace(/\s+/g, '')
    if (!text) throw new Error('报文不能为空')
    if (/[^0-9a-fA-F]/.test(text)) throw new Error('报文包含非 hex 字符，只允许 0-9、A-F')
    if (text.length % 2 !== 0) throw new Error('hex 报文必须是偶数位，每两个字符表示一个字节')
    const bytes = []
    for (let i = 0; i < text.length; i += 2) bytes.push(parseInt(text.slice(i, i + 2), 16))
    return bytes
  }

  function formatHex(bytes) {
    return Array.from(bytes, byte => Number(byte).toString(16).toUpperCase().padStart(2, '0')).join(' ')
  }

  function crc16Modbus(bytes) {
    let crc = 0xFFFF
    for (const byte of bytes) {
      crc ^= Number(byte) & 0xFF
      for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? (crc >>> 1) ^ 0xA001 : crc >>> 1
    }
    return [crc & 0xFF, (crc >>> 8) & 0xFF]
  }

  function appendCrc(bytes) {
    return [...bytes, ...crc16Modbus(bytes)]
  }

  return { parseHex, formatHex, crc16Modbus, appendCrc }
})
