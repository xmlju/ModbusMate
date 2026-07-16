import { describe, it, expect } from 'vitest'
import { parseHex, crc16Modbus, formatHex } from '../renderer/raw-frame.js'

describe('自由报文基础工具', () => {
  it('解析带空格和连续 hex，并计算标准 Modbus CRC', () => {
    const bytes = parseHex('01 03 00 00 00 0A')
    expect(bytes).toEqual([1, 3, 0, 0, 0, 10])
    expect(crc16Modbus(bytes)).toEqual([0xC5, 0xCD])
    expect(formatHex([...bytes, ...crc16Modbus(bytes)])).toBe('01 03 00 00 00 0A C5 CD')
  })

  it('拒绝非 hex 和奇数位输入', () => {
    expect(() => parseHex('01 03 GG')).toThrow('非 hex 字符')
    expect(() => parseHex('010')).toThrow('必须是偶数')
  })
})
