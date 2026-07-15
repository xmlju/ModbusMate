import { describe, expect, it, vi } from 'vitest'
import ModbusService from '../main/modbus-service.js'

function createFakeTransport(overrides = {}) {
  return {
    connected: false,
    connect: vi.fn().mockResolvedValue(undefined),
    reconnect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    read: vi.fn(),
    write: vi.fn(),
    ...overrides,
  }
}

describe('ModbusService facade 连接生命周期', () => {
  it('构造时保存工厂，并在没有传输实例时保持未连接', () => {
    const factory = vi.fn()
    const service = new ModbusService(factory)

    expect(service.factory).toBe(factory)
    expect(service.transport).toBeNull()
    expect(service.params).toBeNull()
    expect(service.connected).toBe(false)
  })

  it('TCP 旧配置使用默认值规范化，并把完整参数传给工厂和传输', async () => {
    const transport = createFakeTransport({ connected: true })
    const factory = vi.fn(() => transport)
    const service = new ModbusService(factory)

    await service.connect({ host: ' 127.0.0.1 ' })

    const expected = {
      transport: 'tcp',
      host: '127.0.0.1',
      port: 502,
      unitId: 1,
      timeout: 2000,
    }
    expect(factory).toHaveBeenCalledWith(expected)
    expect(transport.connect).toHaveBeenCalledWith(expected)
    expect(service.transport).toBe(transport)
    expect(service.params).toEqual(expected)
    expect(service.connected).toBe(true)
  })

  it('RTU 配置使用 9600/8N1 默认值并完整传给工厂', async () => {
    const transport = createFakeTransport()
    const factory = vi.fn(() => transport)
    const service = new ModbusService(factory)

    await service.connect({ transport: 'rtu', serialPath: ' COM3 ' })

    expect(factory).toHaveBeenCalledWith({
      transport: 'rtu',
      serialPath: 'COM3',
      baudRate: 9600,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      unitId: 1,
      timeout: 2000,
    })
  })

  it('新连接成功前不发布传输实例和参数', async () => {
    let finishConnect
    const pending = new Promise(resolve => { finishConnect = resolve })
    const transport = createFakeTransport({ connect: vi.fn(() => pending) })
    const service = new ModbusService(() => transport)

    const connecting = service.connect({ host: 'device.local' })

    await Promise.resolve()
    expect(service.transport).toBeNull()
    expect(service.params).toBeNull()

    finishConnect()
    await connecting
    expect(service.transport).toBe(transport)
    expect(service.params.host).toBe('device.local')
  })

  it('切换连接时先断开旧传输，再创建并连接新传输', async () => {
    const calls = []
    const oldTransport = createFakeTransport({
      disconnect: vi.fn(async () => { calls.push('disconnect-old') }),
    })
    const newTransport = createFakeTransport({
      connect: vi.fn(async () => { calls.push('connect-new') }),
    })
    const factory = vi.fn(() => {
      calls.push('factory')
      return newTransport
    })
    const service = new ModbusService(factory)
    service.transport = oldTransport
    service.params = { transport: 'tcp', host: 'old', port: 502, unitId: 1, timeout: 2000 }

    await service.connect({ host: 'new' })

    expect(calls).toEqual(['disconnect-old', 'factory', 'connect-new'])
    expect(service.transport).toBe(newTransport)
  })

  it('非法新配置不会断开或替换当前连接', async () => {
    const oldTransport = createFakeTransport({ connected: true })
    const factory = vi.fn()
    const service = new ModbusService(factory)
    const oldParams = { transport: 'tcp', host: 'old', port: 502, unitId: 1, timeout: 2000 }
    service.transport = oldTransport
    service.params = oldParams

    await expect(service.connect({ host: '   ' })).rejects.toThrow('host 不能为空')

    expect(oldTransport.disconnect).not.toHaveBeenCalled()
    expect(factory).not.toHaveBeenCalled()
    expect(service.transport).toBe(oldTransport)
    expect(service.params).toBe(oldParams)
    expect(service.connected).toBe(true)
  })

  it('新传输连接失败时不发布失败实例', async () => {
    const failure = new Error('无法连接设备')
    const transport = createFakeTransport({ connect: vi.fn().mockRejectedValue(failure) })
    const service = new ModbusService(() => transport)

    await expect(service.connect({ host: 'offline' })).rejects.toBe(failure)

    expect(service.transport).toBeNull()
    expect(service.params).toBeNull()
  })

  it('connected 仅在当前传输明确报告 true 时为 true', () => {
    const service = new ModbusService(vi.fn())

    service.transport = { connected: 1 }
    expect(service.connected).toBe(false)
    service.transport = { connected: true }
    expect(service.connected).toBe(true)
  })

  it('reconnect 没有传输或参数时给出中文错误', async () => {
    const service = new ModbusService(vi.fn())

    await expect(service.reconnect()).rejects.toThrow('尚未配置过连接参数')
    service.transport = createFakeTransport()
    await expect(service.reconnect()).rejects.toThrow('尚未配置过连接参数')
  })

  it('reconnect 委托现有传输并保持同一实例', async () => {
    const transport = createFakeTransport()
    const service = new ModbusService(vi.fn())
    service.transport = transport
    service.params = { transport: 'tcp', host: 'device', port: 502, unitId: 1, timeout: 2000 }

    await service.reconnect()

    expect(transport.reconnect).toHaveBeenCalledOnce()
    expect(service.transport).toBe(transport)
  })

  it('disconnect 没有传输时安全返回', async () => {
    const service = new ModbusService(vi.fn())

    await expect(service.disconnect()).resolves.toBeUndefined()
  })

  it('disconnect 成功后清空传输引用', async () => {
    const transport = createFakeTransport()
    const service = new ModbusService(vi.fn())
    service.transport = transport

    await service.disconnect()

    expect(transport.disconnect).toHaveBeenCalledOnce()
    expect(service.transport).toBeNull()
  })

  it('disconnect 失败时保留传输引用以便重试', async () => {
    const failure = new Error('关闭失败')
    const transport = createFakeTransport({ disconnect: vi.fn().mockRejectedValue(failure) })
    const service = new ModbusService(vi.fn())
    service.transport = transport

    await expect(service.disconnect()).rejects.toBe(failure)

    expect(service.transport).toBe(transport)
  })
})

describe('ModbusService facade 读写委托', () => {
  it('没有传输时 read/write 都给出设备未连接错误', async () => {
    const service = new ModbusService(vi.fn())

    await expect(service.read('holding', 1, 2)).rejects.toThrow('设备未连接')
    await expect(service.write('holding', 3, [10])).rejects.toThrow('设备未连接')
  })

  it('read 原样委托参数并返回传输结果', async () => {
    const result = [10, 20]
    const transport = createFakeTransport({ read: vi.fn().mockResolvedValue(result) })
    const service = new ModbusService(vi.fn())
    service.transport = transport

    await expect(service.read('holding', 7, 2)).resolves.toBe(result)
    expect(transport.read).toHaveBeenCalledWith('holding', 7, 2)
  })

  it('write 原样委托参数并返回传输结果', async () => {
    const result = { address: 9 }
    const words = [100, 200]
    const transport = createFakeTransport({ write: vi.fn().mockResolvedValue(result) })
    const service = new ModbusService(vi.fn())
    service.transport = transport

    await expect(service.write('holding', 9, words)).resolves.toBe(result)
    expect(transport.write).toHaveBeenCalledWith('holding', 9, words)
  })
})
