// test/seed-data.test.js — 示例数据种子测试
import { describe, it, expect } from 'vitest'
import SeedData from '../renderer/seed-data.js'

describe('SeedData', () => {
  it('sampleTypes 定义了电池柜和PLC', () => {
    expect(SeedData.sampleTypes.length).toBe(2)
    const bat = SeedData.sampleTypes.find(t => t.id === 'sample_battery')
    expect(bat).toBeTruthy()
    expect(bat.name).toBe('电池柜')
    expect(bat.points.length).toBe(5)
  })

  it('电池柜点位各字段完整', () => {
    const bat = SeedData.sampleTypes.find(t => t.id === 'sample_battery')
    bat.points.forEach(p => {
      expect(p.name).toBeTruthy()
      expect(typeof p.addr).toBe('number')
      expect(typeof p.k).toBe('number')
      expect(typeof p.b).toBe('number')
      expect(p.area).toMatch(/^(holding|input|coil|discrete)$/)
      expect(p.type).toBeTruthy()
    })
  })

  it('sampleInstances 指向本地模拟器', () => {
    expect(SeedData.sampleInstances.length).toBe(2)
    const inst1 = SeedData.sampleInstances[0]
    expect(inst1.host).toBe('127.0.0.1')
    expect(inst1.port).toBe(8502)
    expect(inst1.interval).toBe(1000)
  })
})
