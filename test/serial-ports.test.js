import { describe, it, expect } from 'vitest'
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { listSerialPorts } = require('../main/serial-ports')
const { createSerialListHandler, isTrustedAppFrame } = require('../main/serial-ipc')

describe('listSerialPorts', () => {
  it('映射稳定字段，补齐空字段并按 path 排序', async () => {
    const source = [
      { path: '/dev/ttyUSB9', manufacturer: undefined, extra: 'ignore' },
      { path: '/dev/ttyUSB1', serialNumber: 'SN-1', vendorId: '10C4', productId: 'EA60' },
    ]

    await expect(listSerialPorts(async () => source)).resolves.toEqual([
      {
        path: '/dev/ttyUSB1',
        displayName: '/dev/ttyUSB1',
        manufacturer: '',
        serialNumber: 'SN-1',
        vendorId: '10C4',
        productId: 'EA60',
      },
      {
        path: '/dev/ttyUSB9',
        displayName: '/dev/ttyUSB9',
        manufacturer: '',
        serialNumber: '',
        vendorId: '',
        productId: '',
      },
    ])
  })

  it('displayName 包含厂商名称', async () => {
    const [port] = await listSerialPorts(async () => [
      { path: 'COM3', manufacturer: 'Acme' },
    ])

    expect(port.displayName).toBe('COM3 · Acme')
  })

  it('按固定代码点顺序排列大小写和标点路径', async () => {
    const ports = await listSerialPorts(async () => [
      { path: 'com1' },
      { path: '/dev/z' },
      { path: '.hidden' },
      { path: 'COM1' },
      { path: '-virtual' },
    ])

    expect(ports.map(port => port.path)).toEqual([
      '-virtual',
      '.hidden',
      '/dev/z',
      'COM1',
      'com1',
    ])
  })

  it('过滤缺少有效 path 的异常条目', async () => {
    const ports = await listSerialPorts(async () => [
      null,
      {},
      { path: '' },
      { path: '   ' },
      { path: 42 },
      { path: 'COM5' },
    ])

    expect(ports.map(port => port.path)).toEqual(['COM5'])
  })

  it('不修改枚举器返回的原对象和数组顺序', async () => {
    const first = { path: 'COM9', manufacturer: 'Maker' }
    const second = { path: 'COM1' }
    const source = [first, second]
    const snapshot = JSON.parse(JSON.stringify(source))

    await listSerialPorts(async () => source)

    expect(source).toEqual(snapshot)
    expect(source[0]).toBe(first)
    expect(source[1]).toBe(second)
  })

  it('枚举失败时抛出中文错误并保留 cause 和 code', async () => {
    const cause = Object.assign(new Error('permission denied'), { code: 'EACCES' })

    let error
    try {
      await listSerialPorts(async () => { throw cause })
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe('串口枚举失败：permission denied')
    expect(error.cause).toBe(cause)
    expect(error.code).toBe('EACCES')
  })
})

describe('串口 IPC 契约', () => {
  it.each([
    { dependencies: { isTrustedEvent: () => true }, dependencyName: 'listPorts' },
    { dependencies: { listPorts: async () => [] }, dependencyName: 'isTrustedEvent' },
  ])('缺少 $dependencyName 依赖时抛出配置错误', ({ dependencies, dependencyName }) => {
    expect(() => createSerialListHandler(dependencies))
      .toThrow(`串口 IPC 配置错误：${dependencyName} 必须是函数`)
  })

  it('加载纯 IPC 模块时不会加载 serialport 原生依赖', () => {
    const script = `
      const Module = require('module')
      const originalLoad = Module._load
      Module._load = function (request, parent, isMain) {
        if (request === 'serialport' || request.endsWith('/serial-ports')) {
          throw new Error('不应加载原生串口依赖')
        }
        return originalLoad.call(this, request, parent, isMain)
      }
      require(${JSON.stringify(path.join(__dirname, '..', 'main', 'serial-ipc.js'))})
    `

    expect(() => execFileSync(process.execPath, ['-e', script])).not.toThrow()
  })

  it('可信事件枚举成功时返回可序列化结果', async () => {
    const ports = [{ path: 'COM1' }]
    const handler = createSerialListHandler({
      listPorts: async () => ports,
      isTrustedEvent: () => true,
    })

    await expect(handler({})).resolves.toEqual({
      ok: true,
      ports,
    })
  })

  it('信任函数返回 false 时拒绝请求且不调用枚举器', async () => {
    let listCalled = false
    const handler = createSerialListHandler({
      listPorts: async () => { listCalled = true; return [] },
      isTrustedEvent: () => false,
    })

    await expect(handler({ senderFrame: { url: 'file:///tmp/index.html' } }))
      .rejects.toThrow('拒绝未授权的串口枚举请求')
    expect(listCalled).toBe(false)
  })

  it('精确匹配应用窗口、发送者、主 Frame 与入口 URL', () => {
    const expectedUrl = 'file:///app/renderer/index.html'
    const mainFrame = { url: expectedUrl }
    const webContents = { mainFrame }
    const win = { webContents }
    const event = { sender: webContents, senderFrame: mainFrame }

    expect(isTrustedAppFrame(event, win, expectedUrl)).toBe(true)
    expect(isTrustedAppFrame({ ...event, sender: {} }, win, expectedUrl)).toBe(false)
    expect(isTrustedAppFrame({ ...event, senderFrame: {} }, win, expectedUrl)).toBe(false)
    expect(isTrustedAppFrame(event, null, expectedUrl)).toBe(false)
  })

  it.each([
    'file:///tmp/index.html',
    'file://attacker/index.html',
  ])('拒绝非入口 file URL：%s', async url => {
    const expectedUrl = 'file:///app/renderer/index.html'
    const mainFrame = { url }
    const webContents = { mainFrame }
    const win = { webContents }
    const event = { sender: webContents, senderFrame: mainFrame }
    const handler = createSerialListHandler({
      listPorts: async () => [],
      isTrustedEvent: candidate => isTrustedAppFrame(candidate, win, expectedUrl),
    })

    expect(isTrustedAppFrame(event, win, expectedUrl)).toBe(false)
    await expect(handler(event)).rejects.toThrow('拒绝未授权的串口枚举请求')
  })

  it('将枚举错误转换为可序列化对象', async () => {
    const cause = Object.assign(new Error('permission denied'), { code: 'EACCES' })
    const error = Object.assign(new Error('串口枚举失败：permission denied', { cause }), {
      code: 'EACCES',
    })
    const handler = createSerialListHandler({
      listPorts: async () => { throw error },
      isTrustedEvent: () => true,
    })

    await expect(handler({})).resolves.toEqual({
      ok: false,
      error: {
        message: '串口枚举失败：permission denied',
        code: 'EACCES',
        causeMessage: 'permission denied',
      },
    })
  })

  it('主进程与 preload 静态源码使用固定 serial:list 通道（非 Electron 集成测试）', () => {
    const root = path.join(__dirname, '..')
    const main = fs.readFileSync(path.join(root, 'main', 'index.js'), 'utf8')
    const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8')

    expect(main).toContain("ipcMain.handle('serial:list', serialListHandler)")
    expect(main).toContain("win.webContents.on('will-navigate'")
    expect(main).toContain("win.webContents.setWindowOpenHandler")
    expect(preload).toContain("ipcRenderer.invoke('serial:list')")
    expect(preload).not.toMatch(/ipcRenderer\.invoke\([^'\"]/) // 通道必须是源码中的固定字符串
  })
})
