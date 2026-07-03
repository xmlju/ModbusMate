// test/device-manager.test.js — DeviceManager 多设备实例并发采集测试
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import DeviceManager from '../main/device-manager.js'

function stubService(over = {}) {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    reconnect: vi.fn().mockResolvedValue(undefined),
    read: vi.fn().mockResolvedValue([1, 2, 3]),
    write: vi.fn().mockResolvedValue(undefined),
    ...over,
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

const CFG = { host: '127.0.0.1', port: 8502, unitId: 1, interval: 1000, blocks: [{ area: 'holding', addr: 0, count: 3 }] }

describe('DeviceManager', () => {
  it('start 后按周期推送带实例 id 的数据块', async () => {
    const svc = stubService()
    const dm = new DeviceManager(() => svc)
    const onData = vi.fn()
    dm.on('data', onData)
    await dm.start('dev1', CFG)
    await vi.advanceTimersByTimeAsync(2500)
    expect(onData).toHaveBeenCalled()
    const d = onData.mock.calls[0][0]
    expect(d.id).toBe('dev1')
    expect(d.blocks[0].values).toEqual([1, 2, 3])
    await dm.stopAll()
  })

  it('多实例并发独立采集', async () => {
    const svcs = { a: stubService({ read: vi.fn().mockResolvedValue([7]) }), b: stubService({ read: vi.fn().mockResolvedValue([8]) }) }
    let n = 0
    const dm = new DeviceManager(() => (n++ === 0 ? svcs.a : svcs.b))
    const got = {}
    dm.on('data', d => { got[d.id] = d.blocks[0].values })
    await dm.start('a', CFG)
    await dm.start('b', { ...CFG, port: 8503 })
    await vi.advanceTimersByTimeAsync(1500)
    expect(got.a).toEqual([7])
    expect(got.b).toEqual([8])
    await dm.stopAll()
  })

  it('连续 3 次读失败 → offline，重连成功 → connected 并继续采集', async () => {
    const svc = stubService({ read: vi.fn().mockRejectedValue(new Error('Timed out')) })
    const dm = new DeviceManager(() => svc)
    const states = []
    dm.on('status', s => states.push(`${s.id}:${s.state}`))
    dm.on('pollError', () => {})
    await dm.start('dev1', { ...CFG, interval: 100 })
    await vi.advanceTimersByTimeAsync(500)
    expect(states).toContain('dev1:offline')
    svc.read.mockResolvedValue([9])
    await vi.advanceTimersByTimeAsync(6000)
    expect(svc.reconnect).toHaveBeenCalled()
    expect(states.filter(s => s === 'dev1:connected').length).toBeGreaterThanOrEqual(2)
    await dm.stopAll()
  })

  it('stop 断开连接并发出 disconnected', async () => {
    const svc = stubService()
    const dm = new DeviceManager(() => svc)
    const states = []
    dm.on('status', s => states.push(s.state))
    await dm.start('dev1', CFG)
    await dm.stop('dev1')
    expect(svc.disconnect).toHaveBeenCalled()
    expect(states).toContain('disconnected')
  })

  it('未启动的实例 write 报错', async () => {
    const dm = new DeviceManager(() => stubService())
    await expect(dm.write('nope', 'holding', 0, [1])).rejects.toThrow('设备未连接')
  })
})
