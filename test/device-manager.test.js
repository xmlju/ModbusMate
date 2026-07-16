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

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

const CFG = { host: '127.0.0.1', port: 8502, unitId: 1, interval: 1000, blocks: [{ area: 'holding', addr: 0, count: 3 }] }
const RTU_CFG = {
  transport: 'rtu',
  serialPath: 'COM3',
  baudRate: 9600,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  unitId: 1,
  timeout: 2000,
  interval: 1000,
  blocks: [{ area: 'holding', addr: 12508, count: 3 }],
}

describe('DeviceManager', () => {
  it('RTU 配置完整传给服务，并继续按 blocks 采集', async () => {
    const svc = stubService()
    const dm = new DeviceManager(() => svc)

    await dm.start('rtu1', RTU_CFG)

    expect(svc.connect).toHaveBeenCalledOnce()
    expect(svc.connect).toHaveBeenCalledWith(RTU_CFG)
    expect(svc.read).toHaveBeenCalledWith('holding', 12508, 3)

    await dm.stopAll()
    expect(svc.disconnect).toHaveBeenCalledOnce()
  })

  it('旧 TCP 配置仍原样传给服务', async () => {
    const svc = stubService()
    const dm = new DeviceManager(() => svc)

    await dm.start('tcp1', CFG)

    expect(svc.connect).toHaveBeenCalledOnce()
    expect(svc.connect).toHaveBeenCalledWith(CFG)

    await dm.stopAll()
    expect(svc.disconnect).toHaveBeenCalledOnce()
  })

  it('单块读取失败会立即重试一次，重试成功则整轮不失败', async () => {
    // 第一次读失败、第二次成功 → 整轮应正常出 data，不报 pollError
    const read = vi.fn()
      .mockRejectedValueOnce(new Error('Timed out'))
      .mockResolvedValue([9, 9, 9])
    const svc = stubService({ read })
    const dm = new DeviceManager(() => svc)
    const onData = vi.fn(); const onErr = vi.fn()
    dm.on('data', onData); dm.on('pollError', onErr)
    await dm.start('dev1', CFG)
    await vi.advanceTimersByTimeAsync(50)  // 仅跑首轮（周期 1000ms，不触发第二轮）
    expect(onData).toHaveBeenCalled()
    expect(onErr).not.toHaveBeenCalled()
    expect(read).toHaveBeenCalledTimes(2)  // 1 次失败 + 1 次重试
    await dm.stopAll()
  })

  it('单块重试仍失败则整轮失败', async () => {
    const svc = stubService({ read: vi.fn().mockRejectedValue(new Error('Timed out')) })
    const dm = new DeviceManager(() => svc)
    const onErr = vi.fn()
    dm.on('pollError', onErr)
    await dm.start('dev1', CFG)
    await vi.advanceTimersByTimeAsync(1200)
    expect(onErr).toHaveBeenCalled()
    await dm.stopAll()
  })

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

  it('多块采集时在块之间插入间隔，满足从站最小轮询间隔要求', async () => {
    const svc = stubService()
    const dm = new DeviceManager(() => svc)
    // 用立即 resolve 的 _delay 替身，既验证被调用又不阻塞 fake timer
    const delaySpy = vi.spyOn(dm, '_delay').mockResolvedValue(undefined)
    const onData = vi.fn()
    dm.on('data', onData)
    const multiBlock = { ...CFG, blocks: [
      { area: 'holding', addr: 0, count: 3 },
      { area: 'holding', addr: 100, count: 3 },
      { area: 'holding', addr: 200, count: 3 },
    ] }
    await dm.start('dev1', multiBlock)
    await vi.advanceTimersByTimeAsync(1500)

    expect(onData).toHaveBeenCalled()
    expect(onData.mock.calls[0][0].blocks).toHaveLength(3)
    // 3 块之间有 2 个间隔，每个用默认 250ms
    const firstTickDelays = delaySpy.mock.calls.slice(0, 2)
    expect(firstTickDelays).toEqual([[250], [250]])
    await dm.stopAll()
  })

  it('单块采集不插入块间间隔', async () => {
    const svc = stubService()
    const dm = new DeviceManager(() => svc)
    const delaySpy = vi.spyOn(dm, '_delay').mockResolvedValue(undefined)
    dm.on('data', () => {})
    await dm.start('dev1', CFG)
    await vi.advanceTimersByTimeAsync(1500)
    expect(delaySpy).not.toHaveBeenCalled()
    await dm.stopAll()
  })

  it('cfg.blockGap=0 可关闭块间间隔', async () => {
    const svc = stubService()
    const dm = new DeviceManager(() => svc)
    const delaySpy = vi.spyOn(dm, '_delay').mockResolvedValue(undefined)
    dm.on('data', () => {})
    await dm.start('dev1', { ...CFG, blockGap: 0, blocks: [
      { area: 'holding', addr: 0, count: 3 },
      { area: 'holding', addr: 100, count: 3 },
    ] })
    await vi.advanceTimersByTimeAsync(1500)
    expect(delaySpy).not.toHaveBeenCalled()
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

  it('stop 断开失败时保留实例且不误报 disconnected，第二次 stop 会重试', async () => {
    const disconnectError = new Error('串口关闭失败')
    const svc = stubService({
      disconnect: vi.fn()
        .mockRejectedValueOnce(disconnectError)
        .mockResolvedValueOnce(undefined),
    })
    const dm = new DeviceManager(() => svc)
    const states = []
    dm.on('status', s => states.push(s.state))
    await dm.start('dev1', CFG)

    await expect(dm.stop('dev1')).rejects.toBe(disconnectError)

    expect(dm.instances.get('dev1').service.service).toBe(svc)
    expect(states.filter(state => state === 'disconnected')).toHaveLength(0)
    expect(svc.disconnect).toHaveBeenCalledOnce()

    await dm.stop('dev1')

    expect(svc.disconnect).toHaveBeenCalledTimes(2)
    expect(dm.instances.has('dev1')).toBe(false)
    expect(states.filter(state => state === 'disconnected')).toHaveLength(1)
  })

  it('createService 连续同步失败不泄漏 generation/queue，之后同 id 可恢复启动', async () => {
    const factoryError = new Error('服务工厂初始化失败')
    const svc = stubService()
    let attempts = 0
    const dm = new DeviceManager(() => {
      attempts++
      if (attempts <= 2) throw factoryError
      return svc
    })

    expect(() => dm.start('dev1', CFG)).toThrow(factoryError)
    expect(() => dm.start('dev1', CFG)).toThrow(factoryError)
    expect(dm.generations.size).toBe(0)
    expect(dm.lifecycleQueues.size).toBe(0)

    await dm.start('dev1', CFG)

    expect(svc.connect).toHaveBeenCalledOnce()
    await dm.stopAll()
  })

  it('运行实例上再次 start 遇到 factory 同步失败时恢复旧 generation', async () => {
    const factoryError = new Error('新服务创建失败')
    const svc = stubService()
    let attempts = 0
    const dm = new DeviceManager(() => {
      attempts++
      if (attempts === 2) throw factoryError
      return svc
    })
    const onData = vi.fn()
    const states = []
    dm.on('data', onData)
    dm.on('status', s => states.push(s.state))
    await dm.start('dev1', CFG)
    const original = dm.instances.get('dev1')

    expect(() => dm.start('dev1', CFG)).toThrow(factoryError)

    expect(dm.instances.get('dev1')).toBe(original)
    expect(dm.generations.get('dev1')).toBe(original.generation)
    await expect(dm.write('dev1', 'holding', 1, [7])).resolves.toBeUndefined()
    await vi.advanceTimersByTimeAsync(CFG.interval)
    expect(onData).toHaveBeenCalled()
    expect(states).toEqual(['connected'])

    await dm.stop('dev1')
    expect(svc.disconnect).toHaveBeenCalledOnce()
    expect(dm.instances.size).toBe(0)
    expect(dm.generations.size).toBe(0)
    expect(dm.lifecycleQueues.size).toBe(0)
  })

  it('pending start 期间同 id factory 同步失败不淘汰原 pending generation', async () => {
    const connecting = deferred()
    const factoryError = new Error('并发服务创建失败')
    const svc = stubService({ connect: vi.fn(() => connecting.promise) })
    let attempts = 0
    const dm = new DeviceManager(() => {
      attempts++
      if (attempts === 2) throw factoryError
      return svc
    })
    const states = []
    dm.on('status', s => states.push(s.state))

    const starting = dm.start('dev1', CFG)
    const pendingGeneration = dm.instances.get('dev1').generation
    expect(() => dm.start('dev1', CFG)).toThrow(factoryError)
    connecting.resolve()
    await starting

    expect(dm.generations.get('dev1')).toBe(pendingGeneration)
    expect(dm.instances.get('dev1').service.service).toBe(svc)
    expect(states).toEqual(['connected'])
    await dm.stopAll()
  })

  it('不同 id 的 connect 连续失败后不残留 generation、queue 或 instance', async () => {
    const services = [
      stubService({ connect: vi.fn().mockRejectedValue(new Error('A 连接失败')) }),
      stubService({ connect: vi.fn().mockRejectedValue(new Error('B 连接失败')) }),
    ]
    const dm = new DeviceManager(() => services.shift())

    await expect(dm.start('a', CFG)).rejects.toThrow('A 连接失败')
    await expect(dm.start('b', CFG)).rejects.toThrow('B 连接失败')

    expect(dm.instances.size).toBe(0)
    expect(dm.generations.size).toBe(0)
    expect(dm.lifecycleQueues.size).toBe(0)
  })

  it('同 id 并发 start 时淘汰旧 generation，仅保留第二个实例运行', async () => {
    const firstConnect = deferred()
    const first = stubService({ connect: vi.fn(() => firstConnect.promise) })
    const second = stubService()
    let created = 0
    const dm = new DeviceManager(() => (created++ === 0 ? first : second))
    const states = []
    dm.on('status', s => states.push(s.state))

    const firstStart = dm.start('dev1', CFG)
    const secondStart = dm.start('dev1', CFG)
    firstConnect.resolve()
    await firstStart
    await secondStart

    expect(first.disconnect).toHaveBeenCalledOnce()
    expect(second.connect).toHaveBeenCalledOnce()
    expect(states.filter(state => state === 'connected')).toHaveLength(1)
    expect(dm.instances.get('dev1').service.service).toBe(second)
    expect(vi.getTimerCount()).toBe(1)

    await dm.stopAll()
    expect(second.disconnect).toHaveBeenCalledOnce()
  })

  it('pending start 后立即 stop：连接成功结果过期且不创建轮询', async () => {
    const connecting = deferred()
    const svc = stubService({ connect: vi.fn(() => connecting.promise) })
    const dm = new DeviceManager(() => svc)
    const states = []
    dm.on('status', s => states.push(s.state))

    const starting = dm.start('dev1', CFG)
    const stopping = dm.stop('dev1')
    connecting.resolve()
    await starting
    await stopping

    expect(states).not.toContain('connected')
    expect(vi.getTimerCount()).toBe(0)
    expect(svc.disconnect).toHaveBeenCalledOnce()
    expect(dm.instances.has('dev1')).toBe(false)
  })

  it('connect 失败会清理实例、定时器和服务，并抛出原始错误', async () => {
    const connectError = new Error('串口占用')
    const svc = stubService({ connect: vi.fn().mockRejectedValue(connectError) })
    const dm = new DeviceManager(() => svc)

    await expect(dm.start('dev1', RTU_CFG)).rejects.toBe(connectError)

    expect(dm.instances.has('dev1')).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    expect(svc.disconnect).toHaveBeenCalledOnce()
  })

  it('stop 等待在途 tick，停止后不再发出 data 或 pollError', async () => {
    const reading = deferred()
    const svc = stubService({ read: vi.fn(() => reading.promise) })
    const dm = new DeviceManager(() => svc)
    const onData = vi.fn()
    const onPollError = vi.fn()
    dm.on('data', onData)
    dm.on('pollError', onPollError)
    await dm.start('dev1', CFG)

    const stopping = dm.stop('dev1')
    reading.reject(new Error('停止期间读取失败'))
    await stopping

    expect(onData).not.toHaveBeenCalled()
    expect(onPollError).not.toHaveBeenCalled()
    expect(svc.disconnect).toHaveBeenCalledOnce()
    expect(dm.instances.has('dev1')).toBe(false)
  })

  it('stop 等待在途 reconnect，重连完成后不得复活实例', async () => {
    const reconnecting = deferred()
    const svc = stubService({
      read: vi.fn().mockRejectedValue(new Error('Timed out')),
      reconnect: vi.fn(() => reconnecting.promise),
    })
    const dm = new DeviceManager(() => svc)
    const states = []
    dm.on('status', s => states.push(s.state))
    dm.on('pollError', () => {})
    await dm.start('dev1', { ...CFG, interval: 100 })
    await vi.advanceTimersByTimeAsync(300)
    await vi.advanceTimersByTimeAsync(5000)
    expect(svc.reconnect).toHaveBeenCalledOnce()

    const stopping = dm.stop('dev1')
    reconnecting.resolve()
    await stopping

    expect(states.filter(state => state === 'connected')).toHaveLength(1)
    expect(svc.disconnect).toHaveBeenCalledOnce()
    expect(dm.instances.has('dev1')).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('生命周期队列在 start 失败后仍可再次 start', async () => {
    const connectError = new Error('首次连接失败')
    const firstConnect = deferred()
    const first = stubService({ connect: vi.fn(() => firstConnect.promise) })
    const second = stubService()
    let created = 0
    const dm = new DeviceManager(() => (created++ === 0 ? first : second))

    const firstStart = dm.start('dev1', CFG)
    const secondStart = dm.start('dev1', CFG)
    expect(second.connect).not.toHaveBeenCalled()

    firstConnect.reject(connectError)
    await expect(firstStart).rejects.toBe(connectError)
    await secondStart

    expect(second.connect).toHaveBeenCalledOnce()
    expect(dm.instances.get('dev1').service.service).toBe(second)
    await dm.stopAll()
  })

  it('未启动的实例 write 报错', async () => {
    const dm = new DeviceManager(() => stubService())
    await expect(dm.write('nope', 'holding', 0, [1])).rejects.toThrow('设备未连接')
  })
})
