import { describe, it, expect } from 'vitest'
import Codec from '../renderer/codec.js'

const { validatePoints } = Codec

// 合法点位样板
const good = { name: '输出电压', area: 'holding', addr: 4, type: 'uint16', wordOrder: 'AB', k: 0.1, b: 0, decimals: 1, unit: 'V' }

describe('validatePoints — 导入点表校验', () => {
  it('schema 包装的完整对象通过校验', () => {
    const r = validatePoints({ schema: 'modbusmate-points@1', typeName: '云快充充电枪', points: [good, { ...good, name: 'SOC', addr: 7 }] })
    expect(r.ok).toBe(true)
    expect(r.points).toHaveLength(2)
    expect(r.points[0]).toEqual(good)
  })

  it('裸点位数组同样通过校验', () => {
    const r = validatePoints([good])
    expect(r.ok).toBe(true)
    expect(r.points).toHaveLength(1)
  })

  it('非数组且无 points 字段时报格式错误', () => {
    expect(validatePoints({}).error).toContain('未找到点位数组')
    expect(validatePoints('xx').error).toContain('未找到点位数组')
    expect(validatePoints(null).error).toContain('未找到点位数组')
  })

  it('空点位列表报错', () => {
    expect(validatePoints([]).error).toContain('点位列表为空')
  })

  it('缺少名称时报行号', () => {
    const r = validatePoints([good, { ...good, name: '  ' }])
    expect(r.ok).toBe(false)
    expect(r.error).toContain('第 2 个点位')
    expect(r.error).toContain('缺少名称')
  })

  it('区域无效时报错并带点位名', () => {
    const r = validatePoints([{ ...good, area: 'register' }])
    expect(r.error).toContain('区域无效')
    expect(r.error).toContain('输出电压')
  })

  it('数据类型无效时报错', () => {
    expect(validatePoints([{ ...good, type: 'double' }]).error).toContain('数据类型无效')
  })

  it('地址越界或非整数时报错', () => {
    expect(validatePoints([{ ...good, addr: -1 }]).error).toContain('0~65535')
    expect(validatePoints([{ ...good, addr: 65536 }]).error).toContain('0~65535')
    expect(validatePoints([{ ...good, addr: 1.5 }]).error).toContain('0~65535')
    expect(validatePoints([{ ...good, addr: 'abc' }]).error).toContain('0~65535')
  })

  it('k/b 非数字时报错', () => {
    expect(validatePoints([{ ...good, k: 'x' }]).error).toContain('k/b 必须是数字')
    expect(validatePoints([{ ...good, b: 'y' }]).error).toContain('k/b 必须是数字')
  })

  it('小数位超范围时报错', () => {
    expect(validatePoints([{ ...good, decimals: 7 }]).error).toContain('0~6')
    expect(validatePoints([{ ...good, decimals: -1 }]).error).toContain('0~6')
    expect(validatePoints([{ ...good, decimals: 2.5 }]).error).toContain('0~6')
  })

  it('缺省字段补默认值：k=1 b=0 decimals=null unit 空串', () => {
    const r = validatePoints([{ name: 'SOC', area: 'holding', addr: 7, type: 'uint16' }])
    expect(r.ok).toBe(true)
    expect(r.points[0]).toEqual({ name: 'SOC', area: 'holding', addr: 7, type: 'uint16', wordOrder: 'AB', k: 1, b: 0, decimals: null, unit: '' })
  })

  it('decimals 为空串或 null 时规范为 null', () => {
    expect(validatePoints([{ ...good, decimals: '' }]).points[0].decimals).toBe(null)
    expect(validatePoints([{ ...good, decimals: null }]).points[0].decimals).toBe(null)
  })

  it('wordOrder 非 BA 时一律规范为 AB', () => {
    expect(validatePoints([{ ...good, wordOrder: 'BA' }]).points[0].wordOrder).toBe('BA')
    expect(validatePoints([{ ...good, wordOrder: 'ba' }]).points[0].wordOrder).toBe('AB')
    expect(validatePoints([{ ...good, wordOrder: undefined }]).points[0].wordOrder).toBe('AB')
  })

  it('数组中混入非对象元素时报行号', () => {
    const r = validatePoints([good, null])
    expect(r.error).toContain('第 2 个点位')
    expect(r.error).toContain('格式错误')
  })
})
