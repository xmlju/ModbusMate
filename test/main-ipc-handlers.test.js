import { describe, it, expect, vi } from 'vitest'

const { IPC_CHANNELS } = require('../main/ipc-security')
const { createMainIpcHandlers } = require('../main/ipc-handlers')

function createDependencies() {
  const service = {
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    write: vi.fn(async () => 'service-write'),
    rawRequest: vi.fn(async () => ({ tx: '01 03 00 00 00 01 84 0A', rx: '01 03 02 00 7B F8 67' })),
  }
  const poller = {
    running: false,
    start: vi.fn(() => 'poll-start'),
    stop: vi.fn(() => 'poll-stop'),
    write: vi.fn(async () => 'poller-write'),
  }
  const deviceManager = {
    start: vi.fn(async () => 'device-start'),
    stop: vi.fn(async () => 'device-stop'),
    write: vi.fn(async () => 'device-write'),
    rawFrame: vi.fn(async () => ({ tx: '01 55', rx: '' })),
  }
  const fs = {
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(() => Buffer.from('image')),
    copyFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    existsSync: vi.fn(() => true),
  }
  const path = {
    join: vi.fn((...parts) => parts.join('/')),
    extname: vi.fn(value => value.endsWith('.jpg') ? '.jpg' : '.png'),
  }
  const win = { id: 'window' }
  return {
    service,
    poller,
    deviceManager,
    serialListHandler: vi.fn(async () => ({ ok: true, ports: [] })),
    loadConfig: vi.fn(() => ({ saved: true })),
    saveConfig: vi.fn(),
    dialog: {
      showSaveDialog: vi.fn(async () => ({ canceled: true })),
      showOpenDialog: vi.fn(async () => ({ canceled: true })),
    },
    app: { getPath: vi.fn(() => '/data') },
    getWindow: () => win,
    send: vi.fn(),
    fs,
    path,
  }
}

describe('主进程 IPC 业务处理器', () => {
  it('只生成统一安全注册清单声明的全部通道', () => {
    const handlers = createMainIpcHandlers(createDependencies())

    expect(Object.keys(handlers)).toEqual(IPC_CHANNELS)
  })

  it('保持 Modbus 连接参数、状态通知和返回行为', async () => {
    const dependencies = createDependencies()
    const handlers = createMainIpcHandlers(dependencies)
    const params = { transport: 'rtu', path: 'COM3', unitId: 1 }

    await expect(handlers['modbus:connect']({}, params)).resolves.toBeUndefined()
    expect(dependencies.service.connect).toHaveBeenCalledWith(params)
    expect(dependencies.send).toHaveBeenCalledWith('modbus:status', { state: 'connected' })
  })

  it('串口枚举处理器保持原事件和可序列化返回值', async () => {
    const dependencies = createDependencies()
    const handlers = createMainIpcHandlers(dependencies)
    const event = { sender: {} }

    await expect(handlers['serial:list'](event)).resolves.toEqual({ ok: true, ports: [] })
    expect(dependencies.serialListHandler).toHaveBeenCalledWith(event)
  })

  it('写入仍根据轮询状态选择原处理路径并保持参数顺序', async () => {
    const dependencies = createDependencies()
    const handlers = createMainIpcHandlers(dependencies)
    const payload = { area: 'holding', addr: 10, words: [1, 2] }

    await expect(handlers['modbus:write']({}, payload)).resolves.toBe('service-write')
    expect(dependencies.service.write).toHaveBeenCalledWith('holding', 10, [1, 2])

    dependencies.poller.running = true
    await expect(handlers['modbus:write']({}, payload)).resolves.toBe('poller-write')
    expect(dependencies.poller.write).toHaveBeenCalledWith('holding', 10, [1, 2])
  })

  it('原始报文构造发送固定走共享 service 队列，不经 poller 另开连接', async () => {
    const dependencies = createDependencies()
    const handlers = createMainIpcHandlers(dependencies)
    const payload = { unitId: 1, functionCode: 3, addr: 0, count: 1 }

    await expect(handlers['modbus:rawRequest']({}, payload)).resolves.toMatchObject({
      tx: expect.stringContaining('01 03'),
    })
    expect(dependencies.service.rawRequest).toHaveBeenCalledWith(payload)
    expect(dependencies.poller.write).not.toHaveBeenCalled()
  })

  it('文件对话框继续使用动态取得的当前窗口', async () => {
    const dependencies = createDependencies()
    const handlers = createMainIpcHandlers(dependencies)

    await expect(handlers['points:export']({}, { defaultName: 'points.json', json: '{}' }))
      .resolves.toEqual({ ok: false, canceled: true })
    expect(dependencies.dialog.showSaveDialog).toHaveBeenCalledWith(
      dependencies.getWindow(),
      expect.objectContaining({ defaultPath: 'points.json' }),
    )
  })
})
