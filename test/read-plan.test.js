// test/read-plan.test.js — ReadPlan 点位批量读取规划纯函数测试
import { describe, it, expect } from 'vitest'
import ReadPlan from '../renderer/read-plan.js'

const { buildReadPlan, pickValues } = ReadPlan

describe('buildReadPlan 点位合并', () => {
  it('同区域点位合并为一个连续块（含间隙）', () => {
    expect(buildReadPlan([
      { area: 'holding', addr: 0, words: 1 },
      { area: 'holding', addr: 5, words: 2 },
    ])).toEqual([{ area: 'holding', addr: 0, count: 7 }])
  })
  it('不同区域各自成块', () => {
    const plan = buildReadPlan([
      { area: 'holding', addr: 0, words: 1 },
      { area: 'coil', addr: 3, words: 1 },
    ])
    expect(plan).toContainEqual({ area: 'holding', addr: 0, count: 1 })
    expect(plan).toContainEqual({ area: 'coil', addr: 3, count: 1 })
  })
  it('跨度超 120 字拆成多块', () => {
    expect(buildReadPlan([
      { area: 'holding', addr: 0, words: 1 },
      { area: 'holding', addr: 200, words: 1 },
    ])).toEqual([
      { area: 'holding', addr: 0, count: 1 },
      { area: 'holding', addr: 200, count: 1 },
    ])
  })
  it('点位乱序输入也能正确规划', () => {
    expect(buildReadPlan([
      { area: 'holding', addr: 10, words: 2 },
      { area: 'holding', addr: 2, words: 1 },
    ])).toEqual([{ area: 'holding', addr: 2, count: 10 }])
  })
  it('传入更小的 maxBlock 时按该上限拆块（受限帧长设备）', () => {
    // 连续 100 个点，maxBlock=45 → 拆成 45/45/10 三块
    const pts = Array.from({ length: 100 }, (_, i) => ({ area: 'holding', addr: 4000 + i, words: 1 }))
    expect(buildReadPlan(pts, 45)).toEqual([
      { area: 'holding', addr: 4000, count: 45 },
      { area: 'holding', addr: 4045, count: 45 },
      { area: 'holding', addr: 4090, count: 10 },
    ])
  })
  it('maxBlock 非法或缺省时回退到默认 120', () => {
    const pts = Array.from({ length: 130 }, (_, i) => ({ area: 'holding', addr: i, words: 1 }))
    expect(buildReadPlan(pts).length).toBe(2)          // 130 → 120 + 10
    expect(buildReadPlan(pts, 0).length).toBe(2)       // 非法回退默认
  })
  it('maxGap=0 时不跨地址空隙，稀疏寄存器各成一块', () => {
    // 稀疏点位：0、52-53、200 —— 缺省会合并跨空隙，maxGap=0 应拆开
    const pts = [
      { area: 'holding', addr: 0, words: 1 },
      { area: 'holding', addr: 52, words: 2 },
      { area: 'holding', addr: 200, words: 1 },
    ]
    // 缺省(maxGap=Inf)：0 和 52-53 跨空隙合并成一块(0-53)，200 因超 maxBlock 跨度另起
    expect(buildReadPlan(pts)).toEqual([
      { area: 'holding', addr: 0, count: 54 },
      { area: 'holding', addr: 200, count: 1 },
    ])
    expect(buildReadPlan(pts, undefined, 0)).toEqual([
      { area: 'holding', addr: 0, count: 1 },
      { area: 'holding', addr: 52, count: 2 },
      { area: 'holding', addr: 200, count: 1 },
    ])
  })
  it('maxGap 允许小空隙合并、大空隙拆分', () => {
    const pts = [
      { area: 'holding', addr: 0, words: 1 },
      { area: 'holding', addr: 3, words: 1 },   // 空隙 2（1,2）
      { area: 'holding', addr: 20, words: 1 },  // 空隙 16
    ]
    expect(buildReadPlan(pts, undefined, 2)).toEqual([
      { area: 'holding', addr: 0, count: 4 },   // 0 和 3 合并（空隙2≤2）
      { area: 'holding', addr: 20, count: 1 },  // 20 拆开（空隙16>2）
    ])
  })
})

describe('pickValues 切片提取', () => {
  const blocks = [{ area: 'holding', addr: 2, count: 10, values: [10, 11, 12, 13, 14, 15, 16, 17, 18, 19] }]
  it('按点位地址取出寄存器切片', () => {
    expect(pickValues(blocks, { area: 'holding', addr: 5, words: 2 })).toEqual([13, 14])
  })
  it('区域不匹配或越界返回 null', () => {
    expect(pickValues(blocks, { area: 'coil', addr: 5, words: 1 })).toBe(null)
    expect(pickValues(blocks, { area: 'holding', addr: 11, words: 2 })).toBe(null)
  })
})
