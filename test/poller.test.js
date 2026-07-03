import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Poller from '../main/poller.js'

function stubService(over = {}) {
  return {
    read: vi.fn().mockResolvedValue([1, 2, 3]),
    write: vi.fn().mockResolvedValue(undefined),
    reconnect: vi.fn().mockResolvedValue(undefined),
    ...over,
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('Poller', () => {
  it('按周期轮询并推送数据', async () => {
    const svc = stubService()
    const p = new Poller(svc)
    const onData = vi.fn()
    p.on('data', onData)
    p.start({ area: 'holding', addr: 0, count: 3, interval: 1000 })
    await vi.advanceTimersByTimeAsync(3000)
    expect(onData.mock.calls[0][0].values).toEqual([1, 2, 3])
    expect(svc.read.mock.calls.length).toBeGreaterThanOrEqual(3)
    p.stop()
  })

  it('连续 3 次失败 → offline，恢复后自动 online 并继续轮询', async () => {
    const svc = stubService({ read: vi.fn().mockRejectedValue(new Error('Timed out')) })
    const p = new Poller(svc)
    const onOffline = vi.fn(), onOnline = vi.fn()
    p.on('offline', onOffline)
    p.on('online', onOnline)
    p.on('pollError', () => {})
    p.start({ area: 'holding', addr: 0, count: 1, interval: 100 })
    await vi.advanceTimersByTimeAsync(500)
    expect(onOffline).toHaveBeenCalledTimes(1)
    svc.read.mockResolvedValue([9])          // 设备恢复
    await vi.advanceTimersByTimeAsync(6000)  // 5s 重连间隔后成功
    expect(svc.reconnect).toHaveBeenCalled()
    expect(onOnline).toHaveBeenCalledTimes(1)
    p.stop()
  })

  it('write 直接调用服务并 resolve', async () => {
    const svc = stubService()
    const p = new Poller(svc)
    await p.write('holding', 5, [123])
    expect(svc.write).toHaveBeenCalledWith('holding', 5, [123])
  })

  it('write 失败时 reject 并携带错误消息', async () => {
    const svc = stubService({ write: vi.fn().mockRejectedValue(new Error('设备返回异常码 2')) })
    const p = new Poller(svc)
    await expect(p.write('holding', 5, [1])).rejects.toThrow('异常码 2')
  })
})
