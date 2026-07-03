// test/activation.test.js — activate client verifyToken 纯函数测试
import { describe, it, expect } from 'vitest'
import crypto from 'node:crypto'
import { verifyToken } from '../main/activation.js'

const KEY = 'test-key'
const makeToken = (code, expires) =>
  crypto.createHmac('sha256', KEY).update(`${code}.${expires}`).digest('hex')
const daysFromNow = d => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10)

describe('verifyToken 本地验签', () => {
  it('合法且未过期通过', () => {
    const exp = daysFromNow(10)
    expect(verifyToken('ABCD-2345', makeToken('ABCD-2345', exp), exp, KEY)).toBe(true)
  })
  it('签名不匹配拒绝', () => {
    const exp = daysFromNow(10)
    expect(verifyToken('ABCD-2345', 'bad-token', exp, KEY)).toBe(false)
  })
  it('过期 3 天（宽限期内）通过', () => {
    const exp = daysFromNow(-3)
    expect(verifyToken('ABCD-2345', makeToken('ABCD-2345', exp), exp, KEY)).toBe(true)
  })
  it('过期 8 天（超宽限期）拒绝', () => {
    const exp = daysFromNow(-8)
    expect(verifyToken('ABCD-2345', makeToken('ABCD-2345', exp), exp, KEY)).toBe(false)
  })
  it('缺字段拒绝', () => {
    expect(verifyToken(null, 'x', daysFromNow(1), KEY)).toBe(false)
  })
})
