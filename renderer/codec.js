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
    // 非法寄存器值（非 0~65535 整数）返回 null，避免渲染成乱码
    if (typeof w0 !== 'number' || !Number.isInteger(w0) || w0 < 0 || w0 > 0xFFFF) return null
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
    // 空输入防护：Number('') === 0，不拦截会把空输入当 0 写进设备
    if (value === null || value === undefined || String(value).trim() === '') throw new Error('请输入数值')
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
        if (!Number.isFinite(n)) throw new Error('请输入数字')
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

  // PLC 习惯地址基址：线圈 0xxxx（从 1 计）、离散输入 1xxxx、输入寄存器 3xxxx、保持寄存器 4xxxx
  const PLC_BASE = { coil: 1, discrete: 10001, input: 30001, holding: 40001 }

  function toPlcAddress(protocolAddr, area) {
    if (!(area in PLC_BASE)) throw new Error(`未知区域类型: ${area}`)
    return PLC_BASE[area] + protocolAddr
  }

  function toProtocolAddress(plcAddr, area) {
    if (!(area in PLC_BASE)) throw new Error(`未知区域类型: ${area}`)
    const p = plcAddr - PLC_BASE[area]
    if (p < 0 || p > 65535) throw new Error(`地址超出${area === 'holding' ? '保持寄存器' : area === 'input' ? '输入寄存器' : area === 'coil' ? '线圈' : '离散输入'}区域范围`)
    return p
  }

  // 线性公式转换：显示值 = k·x + b；decimals 小数位（null=自动）；非数值原样返回
  function applyTransform(value, { k = 1, b = 0, decimals = null } = {}) {
    if (typeof value !== 'number') return value
    const y = k * value + b
    return decimals === null ? y : Number(y.toFixed(decimals))
  }

  const AREAS = ['holding', 'input', 'coil', 'discrete']

  // 校验导入的点表数据（完整对象取 points 字段，或裸点位数组）
  // 返回 { ok, error, points }；points 为规范化后的副本，缺省字段补默认值
  function validatePoints(raw) {
    const arr = Array.isArray(raw) ? raw : raw?.points
    if (!Array.isArray(arr)) return { ok: false, error: '文件格式错误：未找到点位数组' }
    if (arr.length === 0) return { ok: false, error: '点位列表为空' }
    const points = []
    for (let i = 0; i < arr.length; i++) {
      const p = arr[i]; const row = `第 ${i + 1} 个点位`
      if (!p || typeof p !== 'object') return { ok: false, error: `${row}：格式错误` }
      const name = String(p.name ?? '').trim()
      if (!name) return { ok: false, error: `${row}：缺少名称` }
      if (!AREAS.includes(p.area)) return { ok: false, error: `${row}「${name}」：区域无效（${p.area}）` }
      if (!(p.type in TYPES)) return { ok: false, error: `${row}「${name}」：数据类型无效（${p.type}）` }
      const addr = Number(p.addr)
      if (!Number.isInteger(addr) || addr < 0 || addr > 65535) return { ok: false, error: `${row}「${name}」：地址应为 0~65535 的整数` }
      const k = p.k === undefined ? 1 : Number(p.k)
      const b = p.b === undefined ? 0 : Number(p.b)
      if (Number.isNaN(k) || Number.isNaN(b)) return { ok: false, error: `${row}「${name}」：k/b 必须是数字` }
      let decimals = null
      if (p.decimals !== null && p.decimals !== undefined && p.decimals !== '') {
        decimals = Number(p.decimals)
        if (!Number.isInteger(decimals) || decimals < 0 || decimals > 6) return { ok: false, error: `${row}「${name}」：小数位应为 0~6 的整数` }
      }
      points.push({ name, area: p.area, addr, type: p.type, wordOrder: p.wordOrder === 'BA' ? 'BA' : 'AB', k, b, decimals, unit: String(p.unit ?? '').trim(), visible: p.visible !== false })
    }
    return { ok: true, points }
  }

  return { TYPES, decode, encode, toPlcAddress, toProtocolAddress, applyTransform, validatePoints }
})()

if (typeof module !== 'undefined' && module.exports) module.exports = Codec
