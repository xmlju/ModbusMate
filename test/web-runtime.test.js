import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'

const { createWebRuntime, WEB_RUNTIME_CHANNELS } = require('../main/web-runtime')

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function createDependencies() {
  const service = {
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    write: vi.fn(async () => 'service-write'),
    rawRequest: vi.fn(async () => ({ tx: '01 03 00 00 00 01 84 0A', rx: '01 03 02 00 7B F8 67' })),
  }
  const poller = Object.assign(new EventEmitter(), {
    running: false,
    start: vi.fn(config => config),
    stop: vi.fn(() => undefined),
    write: vi.fn(async () => 'poller-write'),
  })
  const deviceManager = Object.assign(new EventEmitter(), {
    start: vi.fn(async () => 'device-start'),
    stop: vi.fn(async () => 'device-stop'),
    stopAll: vi.fn(async () => undefined),
    write: vi.fn(async () => 'device-write'),
    rawFrame: vi.fn(async () => ({ tx: '01 55', rx: '' })),
  })
  const configStore = {
    load: vi.fn(() => ({ transport: 'rtu' })),
    save: vi.fn(config => ({ ok: true, config })),
  }
  const listSerialPorts = vi.fn(async () => [{ path: 'COM3' }])
  const llmService = Object.assign(new EventEmitter(), {
    extractText: vi.fn(async () => ({ docId: 'doc-1', fileName: '手册.doc', charCount: 300, preview: '预览', format: 'doc' })),
    extractPoints: vi.fn(async () => ({ points: [], stats: { totalTokens: 100 } })),
    testConnection: vi.fn(async () => ({ ok: true, model: 'deepseek-v4-flash', latencyMs: 8, totalTokens: 12 })),
  })
  return { service, poller, deviceManager, configStore, listSerialPorts, llmService }
}

describe('Web Modbus 运行时', () => {
  it('只暴露固定 RPC 白名单', async () => {
    const runtime = createWebRuntime(createDependencies())

    expect(WEB_RUNTIME_CHANNELS).toEqual([
      'serial:list',
      'modbus:connect',
      'modbus:disconnect',
      'modbus:startPoll',
      'modbus:stopPoll',
      'modbus:write',
      'modbus:rawRequest',
      'config:load',
      'config:save',
      'device:start',
      'device:stop',
      'device:write',
      'device:rawFrame',
      'llm:extractText',
      'llm:extractPoints',
      'llm:testConnection',
      'llm:getQuota',
    ])
    await expect(runtime.invoke('points:import')).rejects.toThrow('不支持的运行时通道：points:import')
    await runtime.close()
  })

  it.each(['toString', 'constructor', '__proto__'])(
    '拒绝从普通对象原型继承的伪通道 %s',
    async channel => {
      const runtime = createWebRuntime(createDependencies())

      await expect(runtime.invoke(channel)).rejects.toThrow(`不支持的运行时通道：${channel}`)
      await runtime.close()
    },
  )

  it('保持 preload 的参数和返回语义', async () => {
    const deps = createDependencies()
    const runtime = createWebRuntime(deps)
    const config = { transport: 'rtu', serialPath: 'COM3' }
    const pollConfig = { area: 'holding', addr: 0, count: 2, interval: 1000 }
    const write = { area: 'holding', addr: 10, words: [1, 2] }
    const rawRequest = { unitId: 1, functionCode: 3, addr: 0, count: 1 }
    const device = { id: 'ems', cfg: { transport: 'rtu' } }

    await expect(runtime.invoke('serial:list')).resolves.toEqual([{ path: 'COM3' }])
    await expect(runtime.invoke('modbus:connect', config)).resolves.toBeUndefined()
    expect(deps.service.connect).toHaveBeenCalledWith(config)
    await expect(runtime.invoke('modbus:startPoll', pollConfig)).resolves.toBe(pollConfig)
    expect(deps.poller.start).toHaveBeenCalledWith(pollConfig)
    await expect(runtime.invoke('modbus:write', write)).resolves.toBe('service-write')
    expect(deps.service.write).toHaveBeenCalledWith('holding', 10, [1, 2])
    await expect(runtime.invoke('modbus:rawRequest', rawRequest)).resolves.toMatchObject({ tx: expect.stringContaining('01 03') })
    expect(deps.service.rawRequest).toHaveBeenCalledWith(rawRequest)

    deps.poller.running = true
    await expect(runtime.invoke('modbus:write', write)).resolves.toBe('poller-write')
    expect(deps.poller.write).toHaveBeenCalledWith('holding', 10, [1, 2])

    await expect(runtime.invoke('config:load')).resolves.toEqual({ transport: 'rtu' })
    await expect(runtime.invoke('config:save', config)).resolves.toEqual({ ok: true, config })
    await expect(runtime.invoke('device:start', device)).resolves.toBe('device-start')
    expect(deps.deviceManager.start).toHaveBeenCalledWith('ems', device.cfg)
    await expect(runtime.invoke('device:stop', 'ems')).resolves.toBe('device-stop')
    await expect(runtime.invoke('device:write', { id: 'ems', ...write })).resolves.toBe('device-write')
    expect(deps.deviceManager.write).toHaveBeenCalledWith('ems', 'holding', 10, [1, 2])
    await runtime.close()
  })

  it('LLM 通道委托 llmService 并保持 ok 信封语义', async () => {
    const deps = createDependencies()
    const runtime = createWebRuntime(deps)
    const upload = { fileName: '手册.doc', dataBase64: 'aGk=' }

    await expect(runtime.invoke('llm:extractText', upload)).resolves.toEqual({
      ok: true, docId: 'doc-1', fileName: '手册.doc', charCount: 300, preview: '预览', format: 'doc',
    })
    expect(deps.llmService.extractText).toHaveBeenCalledWith(upload)

    await expect(runtime.invoke('llm:extractPoints', { docId: 'doc-1' }))
      .resolves.toEqual({ points: [], stats: { totalTokens: 100 } })
    expect(deps.llmService.extractPoints).toHaveBeenCalledWith({ docId: 'doc-1' })

    await expect(runtime.invoke('llm:testConnection', { baseURL: 'https://api.deepseek.com', apiKey: 'sk', model: '' }))
      .resolves.toMatchObject({ ok: true, model: 'deepseek-v4-flash' })
    await runtime.close()
  })

  it('转发 LLM 进度事件，关闭后不再转发', async () => {
    const deps = createDependencies()
    const runtime = createWebRuntime(deps)
    const events = []
    runtime.on('event', event => events.push(event))

    const progress = { docId: 'doc-1', segment: 1, totalSegments: 3, accumulatedPoints: 12, accumulatedTokens: 800 }
    deps.llmService.emit('progress', progress)
    expect(events).toEqual([{ channel: 'llm:progress', payload: progress }])

    await runtime.close()
    deps.llmService.emit('progress', { docId: 'doc-1', segment: 2 })
    expect(events).toHaveLength(1)
    await runtime.close()
  })

  it('连接、断开和停止轮询保持 Electron 状态通知语义', async () => {
    const deps = createDependencies()
    const runtime = createWebRuntime(deps)
    const events = []
    runtime.on('event', event => events.push(event))

    await runtime.invoke('modbus:connect', { transport: 'tcp' })
    await runtime.invoke('modbus:stopPoll')
    await runtime.invoke('modbus:disconnect')

    expect(deps.poller.stop).toHaveBeenCalledTimes(2)
    expect(events).toEqual([
      { channel: 'modbus:status', payload: { state: 'connected' } },
      { channel: 'modbus:status', payload: { state: 'disconnected' } },
    ])
    await runtime.close()
  })

  it('转发轮询和设备事件并使用现有中文错误前缀', async () => {
    const deps = createDependencies()
    const runtime = createWebRuntime(deps)
    const events = []
    runtime.on('event', event => events.push(event))

    deps.poller.emit('data', { values: [1] })
    deps.poller.emit('pollError', 'CRC 错误')
    deps.poller.emit('offline')
    deps.poller.emit('online')
    deps.deviceManager.emit('data', { id: 'ems', blocks: [] })
    deps.deviceManager.emit('status', { id: 'ems', state: 'connected' })
    deps.deviceManager.emit('pollError', { id: 'ems', message: '响应超时' })

    expect(events).toEqual([
      { channel: 'modbus:data', payload: { values: [1] } },
      { channel: 'modbus:log', payload: { level: 'error', message: '读取失败：CRC 错误' } },
      { channel: 'modbus:status', payload: { state: 'offline' } },
      { channel: 'modbus:status', payload: { state: 'connected' } },
      { channel: 'device:data', payload: { id: 'ems', blocks: [] } },
      { channel: 'device:status', payload: { id: 'ems', state: 'connected' } },
      { channel: 'device:log', payload: { level: 'error', id: 'ems', message: '读取失败：响应超时' } },
    ])
    await runtime.close()
  })

  it('串口枚举错误保留可序列化的 code 和 cause 信息', async () => {
    const deps = createDependencies()
    const cause = Object.assign(new Error('Access denied'), { code: 'EACCES' })
    deps.listSerialPorts.mockRejectedValue(new Error('串口枚举失败', { cause }))
    const runtime = createWebRuntime(deps)

    let error
    try { await runtime.invoke('serial:list') } catch (caught) { error = caught }

    expect(error.message).toBe('串口枚举失败')
    expect(error.code).toBe('EACCES')
    expect(error.cause).toEqual({ message: 'Access denied', code: 'EACCES' })
    expect(JSON.parse(JSON.stringify(error))).toMatchObject({
      message: '串口枚举失败',
      code: 'EACCES',
      cause: { message: 'Access denied', code: 'EACCES' },
    })
    await runtime.close()
  })

  it.each([
    ['对象', { path: 'COM3' }],
    ['null', null],
    ['字符串', 'COM3'],
  ])('串口枚举返回%s时拒绝异常结果并提供可序列化中文详情', async (_name, result) => {
    const deps = createDependencies()
    deps.listSerialPorts.mockResolvedValue(result)
    const runtime = createWebRuntime(deps)

    let error
    try { await runtime.invoke('serial:list') } catch (caught) { error = caught }

    expect(error.message).toContain('串口枚举结果无效：必须返回端口数组')
    expect(error.cause?.message).toContain('实际类型')
    expect(JSON.parse(JSON.stringify(error))).toMatchObject({
      message: expect.stringContaining('串口枚举结果无效'),
      cause: { message: expect.stringContaining('实际类型') },
    })
    await runtime.close()
  })

  it('关闭时严格串行完成所有清理并且幂等', async () => {
    const deps = createDependencies()
    const stopped = deferred()
    const calls = []
    deps.poller.stop.mockImplementation(() => { calls.push('poller'); return stopped.promise })
    deps.deviceManager.stopAll.mockImplementation(async () => { calls.push('devices') })
    deps.service.disconnect.mockImplementation(async () => { calls.push('service') })
    const runtime = createWebRuntime(deps)

    const first = runtime.close()
    const second = runtime.close()
    expect(first).toBe(second)
    expect(calls).toEqual(['poller'])
    stopped.resolve()
    await first

    expect(calls).toEqual(['poller', 'devices', 'service'])
    expect(deps.poller.stop).toHaveBeenCalledTimes(1)
    expect(deps.deviceManager.stopAll).toHaveBeenCalledTimes(1)
    expect(deps.service.disconnect).toHaveBeenCalledTimes(1)
  })

  it('某个关闭步骤失败仍继续清理并聚合全部错误', async () => {
    const deps = createDependencies()
    const calls = []
    deps.poller.stop.mockImplementation(() => { calls.push('poller'); throw new Error('停止轮询失败') })
    deps.deviceManager.stopAll.mockImplementation(async () => { calls.push('devices'); throw new Error('停止设备失败') })
    deps.service.disconnect.mockImplementation(async () => { calls.push('service'); throw new Error('断开服务失败') })
    const runtime = createWebRuntime(deps)

    let error
    try { await runtime.close() } catch (caught) { error = caught }

    expect(calls).toEqual(['poller', 'devices', 'service'])
    expect(error).toBeInstanceOf(AggregateError)
    expect(error.message).toContain('Web 运行时关闭失败')
    expect(error.errors.map(item => item.message)).toEqual([
      '停止轮询失败',
      '停止设备失败',
      '断开服务失败',
    ])
  })

  it('开始关闭后拒绝调用、移除源监听并且不再转发事件', async () => {
    const deps = createDependencies()
    const runtime = createWebRuntime(deps)
    const events = []
    runtime.on('event', event => events.push(event))
    const beforePoller = deps.poller.listenerCount('data')
    const beforeDevices = deps.deviceManager.listenerCount('data')

    await runtime.close()
    deps.poller.emit('data', { values: [2] })
    deps.deviceManager.emit('data', { id: 'ems' })

    expect(beforePoller).toBe(1)
    expect(beforeDevices).toBe(1)
    expect(deps.poller.listenerCount('data')).toBe(0)
    expect(deps.deviceManager.listenerCount('data')).toBe(0)
    expect(events).toEqual([])
    await expect(runtime.invoke('config:load')).rejects.toThrow('Web 运行时已关闭')
  })
})
