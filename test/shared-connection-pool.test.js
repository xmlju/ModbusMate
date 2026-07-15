// test/shared-connection-pool.test.js — 共享连接池：按连接参数复用底层 service
import { describe, it, expect, vi } from 'vitest'
import { SharedConnectionPool, connectionKey } from '../main/shared-connection-pool.js'

function stubService(over = {}) {
  let connected = false
  return {
    connect: vi.fn().mockImplementation(async () => { connected = true }),
    disconnect: vi.fn().mockImplementation(async () => { connected = false }),
    reconnect: vi.fn().mockImplementation(async () => { connected = true }),
    read: vi.fn().mockResolvedValue([1, 2, 3]),
    write: vi.fn().mockResolvedValue(undefined),
    get connected() { return connected },
    ...over,
  }
}

function deferred() {
  let resolve; let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const RTU_CFG = { transport: 'rtu', serialPath: 'COM3', baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'none', unitId: 1, timeout: 2000 }
const RTU_CFG_OTHER_UNIT = { ...RTU_CFG, unitId: 2 }
const TCP_CFG = { host: '127.0.0.1', port: 502, unitId: 1, timeout: 2000 }

describe('connectionKey', () => {
  it('相同 RTU 参数生成相同 key，不同从站 ID 生成不同 key', () => {
    expect(connectionKey(RTU_CFG)).toBe(connectionKey({ ...RTU_CFG }))
    expect(connectionKey(RTU_CFG)).not.toBe(connectionKey(RTU_CFG_OTHER_UNIT))
  })

  it('TCP 和 RTU 参数生成不同 key', () => {
    expect(connectionKey(TCP_CFG)).not.toBe(connectionKey(RTU_CFG))
  })
})

describe('SharedConnectionPool', () => {
  it('两个句柄使用相同连接参数时只创建并连接一次底层 service', async () => {
    const svc = stubService()
    const pool = new SharedConnectionPool(() => svc)

    const a = pool.createHandle(RTU_CFG)
    const b = pool.createHandle(RTU_CFG)
    await a.connect(RTU_CFG)
    await b.connect(RTU_CFG)

    expect(svc.connect).toHaveBeenCalledOnce()
    expect(a.connected).toBe(true)
    expect(b.connected).toBe(true)
  })

  it('并发 connect 只触发一次底层 connect，第二个等待同一个 in-flight 连接', async () => {
    const gate = deferred()
    const svc = stubService({ connect: vi.fn().mockImplementation(() => gate.promise) })
    const pool = new SharedConnectionPool(() => svc)
    const a = pool.createHandle(RTU_CFG)
    const b = pool.createHandle(RTU_CFG)

    const connectA = a.connect(RTU_CFG)
    const connectB = b.connect(RTU_CFG)
    expect(svc.connect).toHaveBeenCalledOnce()
    gate.resolve()
    await Promise.all([connectA, connectB])
    expect(svc.connect).toHaveBeenCalledOnce()
  })

  it('连接参数不同的句柄各自拥有独立 service', async () => {
    const services = [stubService(), stubService()]
    const pool = new SharedConnectionPool(() => services.shift())
    const a = pool.createHandle(RTU_CFG)
    const b = pool.createHandle(RTU_CFG_OTHER_UNIT)

    await a.connect(RTU_CFG)
    await b.connect(RTU_CFG_OTHER_UNIT)

    expect(a.service).not.toBe(b.service)
  })

  it('只有最后一个引用释放时才真正断开底层连接', async () => {
    const svc = stubService()
    const pool = new SharedConnectionPool(() => svc)
    const a = pool.createHandle(RTU_CFG)
    const b = pool.createHandle(RTU_CFG)
    await a.connect(RTU_CFG)
    await b.connect(RTU_CFG)

    await a.disconnect()
    expect(svc.disconnect).not.toHaveBeenCalled()
    expect(b.connected).toBe(true)

    await b.disconnect()
    expect(svc.disconnect).toHaveBeenCalledOnce()
  })

  it('连接失败时释放引用，不残留空条目，下次重新创建 service', async () => {
    const services = [
      stubService({ connect: vi.fn().mockRejectedValue(new Error('第一次失败')) }),
      stubService(),
    ]
    const pool = new SharedConnectionPool(() => services.shift())
    const a = pool.createHandle(RTU_CFG)

    await expect(a.connect(RTU_CFG)).rejects.toThrow('第一次失败')
    expect(pool.entries.size).toBe(0)

    const b = pool.createHandle(RTU_CFG)
    await b.connect(RTU_CFG)
    expect(b.connected).toBe(true)
  })

  it('两个句柄并发调用 reconnect 时共享同一次重连', async () => {
    const gate = deferred()
    const svc = stubService({ reconnect: vi.fn().mockImplementation(() => gate.promise) })
    const pool = new SharedConnectionPool(() => svc)
    const a = pool.createHandle(RTU_CFG)
    const b = pool.createHandle(RTU_CFG)
    await a.connect(RTU_CFG)
    await b.connect(RTU_CFG)

    const reconnectA = a.reconnect()
    const reconnectB = b.reconnect()
    expect(svc.reconnect).toHaveBeenCalledOnce()
    gate.resolve()
    await Promise.all([reconnectA, reconnectB])
    expect(svc.reconnect).toHaveBeenCalledOnce()
  })

  it('未连接时 read/write 拒绝并提示设备未连接', async () => {
    const pool = new SharedConnectionPool(() => stubService())
    const a = pool.createHandle(RTU_CFG)
    await expect(a.read('holding', 0, 1)).rejects.toThrow('设备未连接')
    await expect(a.write('holding', 0, [1])).rejects.toThrow('设备未连接')
  })

  it('join 已存在的连接时预创建的备用 service 被丢弃，不发起连接', async () => {
    const created = []
    const pool = new SharedConnectionPool(() => { const s = stubService(); created.push(s); return s })
    const a = pool.createHandle(RTU_CFG) // 预创建 created[0]
    const b = pool.createHandle(RTU_CFG) // 预创建 created[1]，但 key 相同，稍后应被丢弃不用

    await a.connect(RTU_CFG)
    await b.connect(RTU_CFG)

    expect(created).toHaveLength(2)
    expect(created[1].connect).not.toHaveBeenCalled()
    expect(a.service).toBe(created[0])
    expect(b.service).toBe(created[0])
  })

  it('断开失败恢复引用计数，允许重试，重试成功后才真正移除连接', async () => {
    const disconnectError = new Error('串口关闭失败')
    const svc = stubService({
      disconnect: vi.fn()
        .mockRejectedValueOnce(disconnectError)
        .mockResolvedValueOnce(undefined),
    })
    const pool = new SharedConnectionPool(() => svc)
    const a = pool.createHandle(RTU_CFG)
    await a.connect(RTU_CFG)

    await expect(a.disconnect()).rejects.toBe(disconnectError)
    expect(pool.entries.has(a.key)).toBe(true)
    expect(a.acquired).toBe(true)

    await a.disconnect()
    expect(svc.disconnect).toHaveBeenCalledTimes(2)
    expect(pool.entries.has(a.key)).toBe(false)
    expect(a.acquired).toBe(false)
  })

  it('读写委托给共享的底层 service', async () => {
    const svc = stubService()
    const pool = new SharedConnectionPool(() => svc)
    const a = pool.createHandle(RTU_CFG)
    await a.connect(RTU_CFG)

    await a.read('holding', 10, 3)
    await a.write('holding', 10, [1, 2])
    expect(svc.read).toHaveBeenCalledWith('holding', 10, 3)
    expect(svc.write).toHaveBeenCalledWith('holding', 10, [1, 2])
  })
})
