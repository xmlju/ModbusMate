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
    rawRequest: vi.fn(),
    ...overrides,
  }
}

function createDeferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
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

  it('并发 connect 按调用顺序执行，最终发布第二个传输并断开第一个', async () => {
    const firstGate = createDeferred()
    const firstTransport = createFakeTransport({
      connect: vi.fn(() => firstGate.promise),
    })
    const secondTransport = createFakeTransport()
    const factory = vi.fn()
      .mockReturnValueOnce(firstTransport)
      .mockReturnValueOnce(secondTransport)
    const service = new ModbusService(factory)

    const firstConnect = service.connect({ host: 'first' })
    const secondConnect = service.connect({ host: 'second' })
    await vi.waitFor(() => expect(firstTransport.connect).toHaveBeenCalledOnce())

    const factoryCallsWhileFirstPending = factory.mock.calls.length
    const secondStartedWhileFirstPending = secondTransport.connect.mock.calls.length

    firstGate.resolve()
    await Promise.all([firstConnect, secondConnect])

    expect(factoryCallsWhileFirstPending).toBe(1)
    expect(secondStartedWhileFirstPending).toBe(0)
    expect(firstTransport.disconnect).toHaveBeenCalledOnce()
    expect(secondTransport.connect).toHaveBeenCalledOnce()
    expect(service.transport).toBe(secondTransport)
    expect(service.params.host).toBe('second')
  })

  it('pending connect 后立即 disconnect，最终断开刚发布的传输', async () => {
    const connectGate = createDeferred()
    const transport = createFakeTransport({
      connect: vi.fn(() => connectGate.promise),
    })
    const service = new ModbusService(() => transport)

    const connecting = service.connect({ host: 'device' })
    const disconnecting = service.disconnect()
    await vi.waitFor(() => expect(transport.connect).toHaveBeenCalledOnce())

    expect(transport.disconnect).not.toHaveBeenCalled()
    connectGate.resolve()
    await Promise.all([connecting, disconnecting])

    expect(transport.disconnect).toHaveBeenCalledOnce()
    expect(service.transport).toBeNull()
  })

  it('connect 后立即 reconnect，等待连接发布后在同一实例重连', async () => {
    const connectGate = createDeferred()
    const transport = createFakeTransport({
      connect: vi.fn(() => connectGate.promise),
    })
    const service = new ModbusService(() => transport)

    const connecting = service.connect({ host: 'device' })
    const reconnecting = service.reconnect()
    reconnecting.catch(() => {})
    await vi.waitFor(() => expect(transport.connect).toHaveBeenCalledOnce())

    expect(transport.reconnect).not.toHaveBeenCalled()
    connectGate.resolve()
    await Promise.all([connecting, reconnecting])

    expect(transport.reconnect).toHaveBeenCalledOnce()
    expect(service.transport).toBe(transport)
  })

  it('前一个 connect 失败后仍执行队列中的下一次 connect', async () => {
    const failure = new Error('首次连接失败')
    const failedTransport = createFakeTransport({
      connect: vi.fn().mockRejectedValue(failure),
    })
    const recoveredTransport = createFakeTransport()
    const factory = vi.fn()
      .mockReturnValueOnce(failedTransport)
      .mockReturnValueOnce(recoveredTransport)
    const service = new ModbusService(factory)

    const failedConnect = service.connect({ host: 'offline' })
    const recoveredConnect = service.connect({ host: 'online' })

    await expect(failedConnect).rejects.toBe(failure)
    await expect(recoveredConnect).resolves.toBeUndefined()
    expect(recoveredTransport.connect).toHaveBeenCalledOnce()
    expect(service.transport).toBe(recoveredTransport)
  })

  it('前一个 disconnect 失败后仍执行队列中的下一次 disconnect', async () => {
    const failure = new Error('首次关闭失败')
    const transport = createFakeTransport({
      disconnect: vi.fn()
        .mockRejectedValueOnce(failure)
        .mockResolvedValueOnce(undefined),
    })
    const service = new ModbusService(vi.fn())
    service.transport = transport

    const failedDisconnect = service.disconnect()
    const recoveredDisconnect = service.disconnect()

    await expect(failedDisconnect).rejects.toBe(failure)
    await expect(recoveredDisconnect).resolves.toBeUndefined()
    expect(transport.disconnect).toHaveBeenCalledTimes(2)
    expect(service.transport).toBeNull()
  })
})

describe('ModbusService facade 读写委托', () => {
  it('reconnect 完成后才执行随后的 read', async () => {
    const reconnectGate = createDeferred()
    const reconnectStarted = createDeferred()
    const transport = createFakeTransport({
      reconnect: vi.fn().mockImplementation(async () => {
        reconnectStarted.resolve()
        await reconnectGate.promise
      }),
      read: vi.fn().mockResolvedValue([123]),
    })
    const service = new ModbusService(vi.fn())
    service.transport = transport
    service.params = { transport: 'tcp', host: 'device', port: 502, unitId: 1, timeout: 2000 }

    const reconnecting = service.reconnect()
    await reconnectStarted.promise
    const reading = service.read('holding', 0, 1)

    expect(transport.read).not.toHaveBeenCalled()
    reconnectGate.resolve()
    await reconnecting
    await expect(reading).resolves.toEqual([123])
    expect(transport.read).toHaveBeenCalledWith('holding', 0, 1)
  })

  it('connect 新配置完成后才把随后的 write 委托给新传输', async () => {
    const connectGate = createDeferred()
    const connectStarted = createDeferred()
    const oldTransport = createFakeTransport()
    const newTransport = createFakeTransport({
      connect: vi.fn().mockImplementation(async () => {
        connectStarted.resolve()
        await connectGate.promise
      }),
      write: vi.fn().mockResolvedValue({ address: 4 }),
    })
    const service = new ModbusService(vi.fn(() => newTransport))
    service.transport = oldTransport
    service.params = { transport: 'tcp', host: 'old', port: 502, unitId: 1, timeout: 2000 }

    const connecting = service.connect({ host: 'new' })
    const writing = service.write('holding', 4, [88])
    await connectStarted.promise

    expect(oldTransport.write).not.toHaveBeenCalled()
    expect(newTransport.write).not.toHaveBeenCalled()
    connectGate.resolve()
    await connecting
    await expect(writing).resolves.toEqual({ address: 4 })
    expect(oldTransport.write).not.toHaveBeenCalled()
    expect(newTransport.write).toHaveBeenCalledWith('holding', 4, [88])
  })

  it('disconnect 等待在途 service read 完成', async () => {
    const readGate = createDeferred()
    const readStarted = createDeferred()
    const transport = createFakeTransport({
      read: vi.fn().mockImplementation(async () => {
        readStarted.resolve()
        await readGate.promise
        return [456]
      }),
    })
    const service = new ModbusService(vi.fn())
    service.transport = transport

    const reading = service.read('holding', 0, 1)
    await readStarted.promise
    const disconnecting = service.disconnect()
    await Promise.resolve()

    expect(transport.disconnect).not.toHaveBeenCalled()
    readGate.resolve()
    await expect(reading).resolves.toEqual([456])
    await disconnecting
    expect(transport.disconnect).toHaveBeenCalledOnce()
    expect(service.transport).toBeNull()
  })

  it('单次操作失败后继续执行队列中的后续操作', async () => {
    const failure = new Error('首次读取失败')
    const firstGate = createDeferred()
    const firstStarted = createDeferred()
    const transport = createFakeTransport({
      read: vi.fn()
        .mockImplementationOnce(async () => {
          firstStarted.resolve()
          await firstGate.promise
          throw failure
        })
        .mockResolvedValueOnce([789]),
    })
    const service = new ModbusService(vi.fn())
    service.transport = transport

    const failedRead = service.read('holding', 0, 1)
    await firstStarted.promise
    const recoveredRead = service.read('holding', 1, 1)

    expect(transport.read).toHaveBeenCalledTimes(1)
    firstGate.resolve()
    await expect(failedRead).rejects.toBe(failure)
    await expect(recoveredRead).resolves.toEqual([789])
    expect(transport.read).toHaveBeenCalledTimes(2)
  })

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

  it('rawRequest 与轮询读写共享 service 操作队列', async () => {
    const readGate = createDeferred()
    const readStarted = createDeferred()
    const rawResult = { tx: '01 03 00 00 00 01 84 0A', rx: '01 03 02 00 7B F8 67' }
    const transport = createFakeTransport({
      read: vi.fn().mockImplementation(async () => {
        readStarted.resolve()
        await readGate.promise
        return [1]
      }),
      rawRequest: vi.fn().mockResolvedValue(rawResult),
    })
    const service = new ModbusService(vi.fn())
    service.transport = transport
    const request = { unitId: 1, functionCode: 3, addr: 0, count: 1 }

    const reading = service.read('holding', 0, 1)
    await readStarted.promise
    const rawSending = service.rawRequest(request)

    expect(transport.rawRequest).not.toHaveBeenCalled()
    readGate.resolve()
    await reading
    await expect(rawSending).resolves.toBe(rawResult)
    expect(transport.rawRequest).toHaveBeenCalledWith(request)
  })

  it('没有传输时 rawRequest 给出设备未连接错误', async () => {
    const service = new ModbusService(vi.fn())

    await expect(service.rawRequest({ unitId: 1, functionCode: 3, addr: 0, count: 1 }))
      .rejects.toThrow('设备未连接')
  })
})
