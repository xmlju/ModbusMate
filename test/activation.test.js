// test/activation.test.js — 激活验证（当前已注释禁用，简化版测试）
import { describe, it, expect } from 'vitest'
import { verifyToken, Activation } from '../main/activation.js'

describe('verifyToken（简化版，始终返回 true）', () => {
  it('verifyToken 是函数', () => {
    expect(typeof verifyToken).toBe('function')
  })
  it('任意参数返回 true', () => {
    expect(verifyToken()).toBe(true)
    expect(verifyToken(null, null, null, 'key')).toBe(true)
    expect(verifyToken('x', 'y', 'z', 'key')).toBe(true)
  })
})

describe('Activation（简化版，始终已激活）', () => {
  it('isActivated 始终返回 true', () => {
    const a = new Activation()
    expect(a.isActivated()).toBe(true)
  })
  it('activate 返回 { ok: true }', async () => {
    const a = new Activation()
    expect(await a.activate()).toEqual({ ok: true })
  })
})
