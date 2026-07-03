import { describe, it, expect } from 'vitest'
import Codec from '../renderer/codec.js'

const { decode, encode, TYPES, toPlcAddress, toProtocolAddress, applyTransform } = Codec

describe('16 位类型解码', () => {
  it('UInt16 原样返回', () => {
    expect(decode([250], 0, 'uint16')).toBe(250)
    expect(decode([0xFFFF], 0, 'uint16')).toBe(65535)
  })
  it('Int16 负数补码转换', () => {
    expect(decode([0xFFFB], 0, 'int16')).toBe(-5)
    expect(decode([0x7FFF], 0, 'int16')).toBe(32767)
  })
  it('Hex 显示为 4 位大写十六进制', () => {
    expect(decode([0x00FA], 0, 'hex')).toBe('0x00FA')
  })
  it('越界 offset 返回 null', () => {
    expect(decode([1], 5, 'uint16')).toBe(null)
  })
})

describe('16 位类型编码', () => {
  it('UInt16 编码为单字', () => {
    expect(encode('250', 'uint16')).toEqual([250])
  })
  it('Int16 负数编码为补码', () => {
    expect(encode('-5', 'int16')).toEqual([0xFFFB])
  })
  it('Hex 解析（带/不带 0x 前缀）', () => {
    expect(encode('1A2B', 'hex')).toEqual([0x1A2B])
    expect(encode('0x1A2B', 'hex')).toEqual([0x1A2B])
  })
  it('超范围抛出带范围说明的错误', () => {
    expect(() => encode('70000', 'uint16')).toThrow('0 ~ 65535')
    expect(() => encode('-40000', 'int16')).toThrow('-32768 ~ 32767')
    expect(() => encode('XYZ9', 'hex')).toThrow('十六进制')
  })
})

describe('TYPES 元数据', () => {
  it('含全部 6 种类型及字数', () => {
    expect(TYPES.int16.words).toBe(1)
    expect(TYPES.float32.words).toBe(2)
    expect(Object.keys(TYPES)).toEqual(['int16', 'uint16', 'int32', 'uint32', 'float32', 'hex'])
  })
})

describe('32 位类型解码（字序）', () => {
  // 25.6 的 IEEE754 = 0x41CCCCCD
  it('Float32 AB 字序（高字在前）', () => {
    expect(decode([0x41CC, 0xCCCD], 0, 'float32', 'AB')).toBeCloseTo(25.6, 5)
  })
  it('Float32 BA 字序（低字在前）', () => {
    expect(decode([0xCCCD, 0x41CC], 0, 'float32', 'BA')).toBeCloseTo(25.6, 5)
  })
  it('Int32 负数', () => {
    expect(decode([0xFFFF, 0xFFFF], 0, 'int32', 'AB')).toBe(-1)
  })
  it('UInt32', () => {
    expect(decode([0x1234, 0x5678], 0, 'uint32', 'AB')).toBe(0x12345678)
  })
  it('缺少第二个寄存器返回 null', () => {
    expect(decode([0x41CC], 0, 'float32', 'AB')).toBe(null)
  })
})

describe('32 位类型编码（字序）', () => {
  it('Float32 AB 编码为两个字', () => {
    expect(encode('25.6', 'float32', 'AB')).toEqual([0x41CC, 0xCCCD])
  })
  it('Float32 BA 字序反转', () => {
    expect(encode('25.6', 'float32', 'BA')).toEqual([0xCCCD, 0x41CC])
  })
  it('Int32 负数编码', () => {
    expect(encode('-1', 'int32', 'AB')).toEqual([0xFFFF, 0xFFFF])
  })
  it('UInt32 超范围抛错', () => {
    expect(() => encode('4294967296', 'uint32')).toThrow('0 ~ 4294967295')
  })
  it('非数字输入抛错', () => {
    expect(() => encode('abc', 'float32')).toThrow('请输入数字')
  })
})

describe('PLC/协议地址换算', () => {
  it('协议地址 → PLC 习惯地址', () => {
    expect(toPlcAddress(0, 'coil')).toBe(1)
    expect(toPlcAddress(0, 'discrete')).toBe(10001)
    expect(toPlcAddress(9, 'input')).toBe(30010)
    expect(toPlcAddress(0, 'holding')).toBe(40001)
    expect(toPlcAddress(99, 'holding')).toBe(40100)
  })
  it('PLC 地址 → 协议地址', () => {
    expect(toProtocolAddress(40001, 'holding')).toBe(0)
    expect(toProtocolAddress(30010, 'input')).toBe(9)
  })
  it('PLC 地址低于区域基址抛错', () => {
    expect(() => toProtocolAddress(39999, 'holding')).toThrow('超出')
  })
})

describe('线性公式转换 applyTransform', () => {
  it('y = k·x + b', () => {
    expect(applyTransform(250, { k: 0.1, b: 0 })).toBeCloseTo(25, 6)
    expect(applyTransform(500, { k: 0.1, b: -40 })).toBeCloseTo(10, 6)
  })
  it('小数位控制', () => {
    expect(applyTransform(333, { k: 1 / 3, b: 0, decimals: 2 })).toBe(111)
    expect(applyTransform(100, { k: 0.123, b: 0, decimals: 2 })).toBe(12.3)
  })
  it('默认参数不改变数值', () => {
    expect(applyTransform(42, {})).toBe(42)
    expect(applyTransform(42)).toBe(42)
  })
  it('非数值（Hex 字符串）原样返回', () => {
    expect(applyTransform('0x00FA', { k: 0.1 })).toBe('0x00FA')
  })
})

describe('输入防护（质量审查修复）', () => {
  it('空输入抛错而不是静默写 0', () => {
    expect(() => encode('', 'uint16')).toThrow('请输入数值')
    expect(() => encode('   ', 'int32')).toThrow('请输入数值')
    expect(() => encode(null, 'uint32')).toThrow('请输入数值')
  })
  it('Infinity 不允许写入', () => {
    expect(() => encode('Infinity', 'float32')).toThrow('请输入数字')
  })
  it('未知区域类型抛错而不是产出 NaN 地址', () => {
    expect(() => toPlcAddress(0, 'foo')).toThrow('未知区域')
    expect(() => toProtocolAddress(40001, 'foo')).toThrow('未知区域')
  })
  it('非法寄存器值解码返回 null 而不是乱码', () => {
    expect(decode([-5], 0, 'hex')).toBe(null)
    expect(decode([12.7], 0, 'uint16')).toBe(null)
  })
  it('边界值编解码往返：-32768 与 65535', () => {
    expect(decode(encode('-32768', 'int16'), 0, 'int16')).toBe(-32768)
    expect(decode(encode('65535', 'uint16'), 0, 'uint16')).toBe(65535)
  })
})
