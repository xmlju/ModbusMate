import { describe, it, expect } from 'vitest'
import { PROFILES } from '../scripts/simulate-device.js'

describe('模拟设备 Profiles', () => {
  it('所有 profile 均有必要字段', () => {
    Object.entries(PROFILES).forEach(([name, p]) => {
      expect(p.name).toBeTruthy()
      expect(p.desc).toBeTruthy()
      expect(typeof p.init).toBe('function')
      expect(typeof p.tick).toBe('function')
      expect(typeof p.describe).toBe('function')
    })
  })

  it('所有 profile init 不抛异常', () => {
    Object.entries(PROFILES).forEach(([name, p]) => {
      const holding = new Uint16Array(p.holdingSize || 200)
      const coils = new Uint8Array(p.coilsSize || 200)
      expect(() => p.init(holding, coils)).not.toThrow()
      // verify some values were written
      const hasData = Array.from(holding).some(v => v !== 0)
      expect(hasData).toBe(true)
    })
  })

  it('所有 profile tick 不抛异常', () => {
    Object.entries(PROFILES).forEach(([name, p]) => {
      const holding = new Uint16Array(p.holdingSize || 200)
      const coils = new Uint8Array(p.coilsSize || 200)
      p.init(holding, coils)
      expect(() => p.tick(holding, coils, 5)).not.toThrow()
    })
  })

  it('所有 profile describe 返回字符串', () => {
    Object.entries(PROFILES).forEach(([name, p]) => {
      const holding = new Uint16Array(p.holdingSize || 200)
      const coils = new Uint8Array(p.coilsSize || 200)
      p.init(holding, coils)
      const desc = p.describe(holding)
      expect(typeof desc).toBe('string')
      expect(desc.length).toBeGreaterThan(5)
    })
  })
})
