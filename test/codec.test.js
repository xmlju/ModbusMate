import { describe, it, expect } from 'vitest'
import Codec from '../renderer/codec.js'

const { decode, encode, TYPES } = Codec

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
