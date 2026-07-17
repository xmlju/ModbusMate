// test/llm-utils.test.js — renderer/llm-utils.js 四个纯函数全覆盖单测

import { describe, it, expect } from 'vitest'

const {
  areaStats,
  estimateCost,
  chunkBase64,
  generateDefaultTypeName,
  AREAS,
} = require('../renderer/llm-utils.js')

// ═══════════════════════════════════════════════
// areaStats
// ═══════════════════════════════════════════════
describe('areaStats — 区域分布统计', () => {
  it('混合区域正确统计', () => {
    const points = [
      { name: 'a', area: 'holding', addr: 0 },
      { name: 'b', area: 'holding', addr: 1 },
      { name: 'c', area: 'input', addr: 0 },
      { name: 'd', area: 'coil', addr: 0 },
      { name: 'e', area: 'coil', addr: 1 },
      { name: 'f', area: 'coil', addr: 2 },
      { name: 'g', area: 'discrete', addr: 0 },
    ]
    const stats = areaStats(points)
    expect(stats.holding).toBe(2)
    expect(stats.input).toBe(1)
    expect(stats.coil).toBe(3)
    expect(stats.discrete).toBe(1)
    expect(stats.total).toBe(7)
  })

  it('空数组返回全零', () => {
    const stats = areaStats([])
    expect(stats).toEqual({ holding: 0, input: 0, coil: 0, discrete: 0, total: 0 })
  })

  it('非数组输入返回全零', () => {
    expect(areaStats(null)).toEqual({ holding: 0, input: 0, coil: 0, discrete: 0, total: 0 })
    expect(areaStats('str')).toEqual({ holding: 0, input: 0, coil: 0, discrete: 0, total: 0 })
    expect(areaStats(undefined)).toEqual({ holding: 0, input: 0, coil: 0, discrete: 0, total: 0 })
  })

  it('非标准 area 值不计入', () => {
    const points = [
      { name: 'x', area: 'holding', addr: 0 },
      { name: 'y', area: 'register', addr: 1 },
      { name: 'z', area: null, addr: 2 },
    ]
    const stats = areaStats(points)
    expect(stats.holding).toBe(1)
    expect(stats.total).toBe(1)
  })

  it('数组含 null/undefined 元素跳过', () => {
    const points = [null, { name: 'a', area: 'holding' }, undefined]
    const stats = areaStats(points)
    expect(stats.holding).toBe(1)
    expect(stats.total).toBe(1)
  })

  it('全部是 holding 区域', () => {
    const points = Array.from({ length: 100 }, (_, i) => ({ area: 'holding', addr: i }))
    const stats = areaStats(points)
    expect(stats.holding).toBe(100)
    expect(stats.total).toBe(100)
    expect(stats.input).toBe(0)
    expect(stats.coil).toBe(0)
    expect(stats.discrete).toBe(0)
  })
})

// ═══════════════════════════════════════════════
// estimateCost
// ═══════════════════════════════════════════════
describe('estimateCost — token 费用估算', () => {
  it('默认价格: 1M tokens = ¥4', () => {
    const cost = estimateCost(1000000)
    expect(cost.totalCost).toBe(4.00)
  })

  it('自定义价格: 1M tokens * 2 = ¥2', () => {
    const cost = estimateCost(1000000, 2)
    expect(cost.totalCost).toBe(2.00)
  })

  it('500K tokens 默认价格 = ¥2', () => {
    const cost = estimateCost(500000)
    expect(cost.totalCost).toBe(2.00)
  })

  it('小用量含小数舍入: 1500 tokens * 4 = ¥0.01', () => {
    // 1500 / 1000000 * 4 = 0.006 → roundCent → 0.01
    const cost = estimateCost(1500)
    expect(cost.totalCost).toBe(0.01)
  })

  it('零值输入返回零费用', () => {
    const cost = estimateCost(0)
    expect(cost).toEqual({ totalCost: 0 })
  })

  it('负值输入被修正为 0', () => {
    const cost = estimateCost(-100)
    expect(cost).toEqual({ totalCost: 0 })
  })

  it('非数字输入被修正为 0', () => {
    const cost = estimateCost('abc')
    expect(cost).toEqual({ totalCost: 0 })
  })
})

// ═══════════════════════════════════════════════
// chunkBase64
// ═══════════════════════════════════════════════
describe('chunkBase64 — base64 分块', () => {
  it('小于默认块大小的字符串单块返回', () => {
    const data = 'YWJjZGVm' // base64 of "abcdef"
    const result = chunkBase64(data)
    expect(result.chunks).toHaveLength(1)
    expect(result.chunks[0]).toBe(data)
    expect(result.totalChunks).toBe(1)
  })

  it('超过默认块大小时分多块', () => {
    const data = 'A'.repeat(300 * 1024) // 300K characters
    const result = chunkBase64(data)
    expect(result.totalChunks).toBe(2)
    expect(result.chunks[0].length).toBe(256 * 1024)
    expect(result.chunks[1].length).toBe(300 * 1024 - 256 * 1024)
  })

  it('自定义块大小', () => {
    const data = 'ABCDEFGHIJ' // 10 chars
    const result = chunkBase64(data, 3)
    expect(result.chunks).toEqual(['ABC', 'DEF', 'GHI', 'J'])
    expect(result.totalChunks).toBe(4)
  })

  it('空字符串返回 chunks=[] totalChunks=0', () => {
    const result = chunkBase64('')
    expect(result.chunks).toEqual([])
    expect(result.totalChunks).toBe(0)
  })

  it('null/undefined 输入视为空字符串', () => {
    const r1 = chunkBase64(null)
    const r2 = chunkBase64(undefined)
    expect(r1.totalChunks).toBe(0)
    expect(r2.totalChunks).toBe(0)
  })

  it('块大小正好整除', () => {
    const data = 'AB'.repeat(5) // 10 chars
    const result = chunkBase64(data, 2)
    expect(result.chunks).toEqual(['AB', 'AB', 'AB', 'AB', 'AB'])
    expect(result.totalChunks).toBe(5)
  })

  it('拼接所有块后恢复原文', () => {
    const data = 'base64模拟数据'.repeat(500)
    const result = chunkBase64(data, 100)
    const joined = result.chunks.join('')
    expect(joined).toBe(data)
  })
})

// ═══════════════════════════════════════════════
// generateDefaultTypeName
// ═══════════════════════════════════════════════
describe('generateDefaultTypeName — 类型名默认值', () => {
  it('空列表 → "新建类型_YYYY-MM-DD"', () => {
    const name = generateDefaultTypeName([], '2026-07-17')
    expect(name).toBe('新建类型_2026-07-17')
  })

  it('已有同名 → 自动 + (2)', () => {
    const existing = ['PCS', '新建类型_2026-07-17']
    const name = generateDefaultTypeName(existing, '2026-07-17')
    expect(name).toBe('新建类型_2026-07-17 (2)')
  })

  it('已有 (2) 和 (3) → 跳至 (4)', () => {
    const existing = [
      '新建类型_2026-07-17',
      '新建类型_2026-07-17 (2)',
      '新建类型_2026-07-17 (3)',
    ]
    const name = generateDefaultTypeName(existing, '2026-07-17')
    expect(name).toBe('新建类型_2026-07-17 (4)')
  })

  it('未传日期 → 使用今天的日期', () => {
    const name = generateDefaultTypeName([])
    const today = new Date().toISOString().slice(0, 10)
    expect(name).toBe(`新建类型_${today}`)
  })

  it('传入 Date 对象', () => {
    const name = generateDefaultTypeName([], new Date('2026-12-25'))
    expect(name).toBe('新建类型_2026-12-25')
  })

  it('空数组也算无冲突', () => {
    const name = generateDefaultTypeName([], '2025-01-01')
    expect(name).toBe('新建类型_2025-01-01')
  })

  it('existingNames 为 null/undefined 时正常生成', () => {
    const n1 = generateDefaultTypeName(null, '2026-01-01')
    const n2 = generateDefaultTypeName(undefined, '2026-01-01')
    expect(n1).toBe('新建类型_2026-01-01')
    expect(n2).toBe('新建类型_2026-01-01')
  })

  it('existingNames 含有空白字符串', () => {
    const existing = ['  ', '\t', '新建类型_2026-07-17']
    const name = generateDefaultTypeName(existing, '2026-07-17')
    expect(name).toBe('新建类型_2026-07-17 (2)')
  })
})

// ═══════════════════════════════════════════════
describe('AREAS 常量', () => {
  it('包含四种 Modbus 区域', () => {
    expect(AREAS).toEqual(['holding', 'input', 'coil', 'discrete'])
  })
})
