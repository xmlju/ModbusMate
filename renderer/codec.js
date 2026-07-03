// renderer/codec.js — 数据类型编解码与地址换算（纯函数，无依赖）
// 浏览器：<script> 引入后使用全局 Codec；Vitest：module.exports 加载
const Codec = (() => {

  const TYPES = {
    int16:   { label: 'Int16',   words: 1 },
    uint16:  { label: 'UInt16',  words: 1 },
    int32:   { label: 'Int32',   words: 2 },
    uint32:  { label: 'UInt32',  words: 2 },
    float32: { label: 'Float32', words: 2 },
    hex:     { label: 'Hex',     words: 1 },
  }

  // 两个 16 位字合成 32 位无符号整数
  function toU32(w0, w1, wordOrder) {
    const [hi, lo] = wordOrder === 'BA' ? [w1, w0] : [w0, w1]
    return hi * 0x10000 + lo
  }

  // registers: 16 位原始值数组；offset: 行下标；wordOrder: 'AB' 高字在前 / 'BA' 低字在前
  function decode(registers, offset, type, wordOrder = 'AB') {
    const w0 = registers[offset]
    if (w0 === undefined) return null
    switch (type) {
      case 'uint16': return w0
      case 'int16':  return w0 > 0x7FFF ? w0 - 0x10000 : w0
      case 'hex':    return '0x' + w0.toString(16).toUpperCase().padStart(4, '0')
      case 'uint32':
      case 'int32':
      case 'float32': {
        const w1 = registers[offset + 1]
        if (w1 === undefined) return null
        const u32 = toU32(w0, w1, wordOrder)
        if (type === 'uint32') return u32
        if (type === 'int32') return u32 > 0x7FFFFFFF ? u32 - 0x100000000 : u32
        const buf = new DataView(new ArrayBuffer(4))
        buf.setUint32(0, u32)
        return buf.getFloat32(0)
      }
      default: throw new Error(`未知数据类型: ${type}`)
    }
  }

  // 返回待写入的 16 位字数组（长度 1 或 2）
  function encode(value, type, wordOrder = 'AB') {
    switch (type) {
      case 'uint16': {
        const n = Number(value)
        if (!Number.isInteger(n) || n < 0 || n > 0xFFFF) throw new Error('UInt16 取值范围 0 ~ 65535')
        return [n]
      }
      case 'int16': {
        const n = Number(value)
        if (!Number.isInteger(n) || n < -0x8000 || n > 0x7FFF) throw new Error('Int16 取值范围 -32768 ~ 32767')
        return [n < 0 ? n + 0x10000 : n]
      }
      case 'hex': {
        const s = String(value).trim().replace(/^0x/i, '')
        if (!/^[0-9a-fA-F]{1,4}$/.test(s)) throw new Error('Hex 格式应为 1~4 位十六进制，如 1A2B')
        return [parseInt(s, 16)]
      }
      case 'uint32':
      case 'int32':
      case 'float32': {
        const n = Number(value)
        if (Number.isNaN(n)) throw new Error('请输入数字')
        const buf = new DataView(new ArrayBuffer(4))
        if (type === 'float32') {
          buf.setFloat32(0, n)
        } else {
          if (!Number.isInteger(n)) throw new Error('请输入整数')
          if (type === 'uint32' && (n < 0 || n > 0xFFFFFFFF)) throw new Error('UInt32 取值范围 0 ~ 4294967295')
          if (type === 'int32' && (n < -0x80000000 || n > 0x7FFFFFFF)) throw new Error('Int32 取值范围 -2147483648 ~ 2147483647')
          buf.setUint32(0, n < 0 ? n + 0x100000000 : n)
        }
        const hi = buf.getUint16(0), lo = buf.getUint16(2)
        return wordOrder === 'BA' ? [lo, hi] : [hi, lo]
      }
      default: throw new Error(`未知数据类型: ${type}`)
    }
  }

  return { TYPES, decode, encode }
})()

if (typeof module !== 'undefined' && module.exports) module.exports = Codec
