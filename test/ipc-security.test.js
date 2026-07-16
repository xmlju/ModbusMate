import { describe, it, expect, vi } from 'vitest'

const {
  IPC_CHANNELS,
  createTrustedIpcHandler,
  registerTrustedIpcHandlers,
} = require('../main/ipc-security')

function createTrustedFixture(expectedUrl = 'file:///app/renderer/index.html') {
  const mainFrame = { url: expectedUrl }
  const webContents = { mainFrame, isDestroyed: () => false }
  const win = { webContents, isDestroyed: () => false }
  const event = { sender: webContents, senderFrame: mainFrame }
  return { expectedUrl, mainFrame, webContents, win, event }
}

describe('高权限 IPC 可信边界', () => {
  it('可信应用窗口的主 frame 可调用，并原样传递参数与返回值', async () => {
    const fixture = createTrustedFixture()
    const businessHandler = vi.fn(async (_event, first, second) => ({ first, second }))
    const handler = createTrustedIpcHandler({
      channel: 'modbus:connect',
      getWindow: () => fixture.win,
      expectedUrl: fixture.expectedUrl,
      handler: businessHandler,
    })

    await expect(handler(fixture.event, 'a', { b: 2 })).resolves.toEqual({
      first: 'a',
      second: { b: 2 },
    })
    expect(businessHandler).toHaveBeenCalledWith(fixture.event, 'a', { b: 2 })
  })

  it('同一 sender 的子 frame 被拒绝，且业务处理器不执行', async () => {
    const fixture = createTrustedFixture()
    const businessHandler = vi.fn()
    const handler = createTrustedIpcHandler({
      channel: 'config:save',
      getWindow: () => fixture.win,
      expectedUrl: fixture.expectedUrl,
      handler: businessHandler,
    })
    const childFrameEvent = {
      sender: fixture.webContents,
      senderFrame: { url: fixture.expectedUrl },
    }

    await expect(handler(childFrameEvent, {})).rejects.toThrow(
      '拒绝未授权的 IPC 请求（通道：config:save）',
    )
    expect(businessHandler).not.toHaveBeenCalled()
  })

  it('伪造相同 URL 的其他 sender 被拒绝', async () => {
    const fixture = createTrustedFixture()
    const handler = createTrustedIpcHandler({
      channel: 'read-image',
      getWindow: () => fixture.win,
      expectedUrl: fixture.expectedUrl,
      handler: vi.fn(),
    })
    const fakeMainFrame = { url: fixture.expectedUrl }
    const fakeEvent = {
      sender: { mainFrame: fakeMainFrame },
      senderFrame: fakeMainFrame,
    }

    await expect(handler(fakeEvent, 'images/x.png')).rejects.toThrow(
      '仅允许当前应用窗口的可信主页面调用',
    )
  })

  it.each([
    ['窗口尚未创建', () => null],
    ['窗口已销毁', fixture => ({ ...fixture.win, isDestroyed: () => true })],
    ['webContents 已销毁', fixture => ({
      ...fixture.win,
      webContents: { ...fixture.webContents, isDestroyed: () => true },
    })],
  ])('%s 时拒绝请求', async (_name, getFixtureWindow) => {
    const fixture = createTrustedFixture()
    const handler = createTrustedIpcHandler({
      channel: 'device:start',
      getWindow: () => getFixtureWindow(fixture),
      expectedUrl: fixture.expectedUrl,
      handler: vi.fn(),
    })

    await expect(handler(fixture.event, {})).rejects.toThrow(
      '拒绝未授权的 IPC 请求（通道：device:start）',
    )
  })
})

describe('高权限 IPC 统一注册', () => {
  it('完整通道清单与当前主进程能力一致', () => {
    expect(IPC_CHANNELS).toEqual([
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
      'points:export',
      'points:import',
      'copy-image',
      'read-image',
      'save-image',
    ])
  })

  it('所有业务处理器只通过可信包装器注册，且动态读取当前窗口', async () => {
    const fixture = createTrustedFixture()
    let currentWindow = null
    const registered = new Map()
    const ipcMain = {
      handle: vi.fn((channel, handler) => registered.set(channel, handler)),
    }
    const handlers = Object.fromEntries(
      IPC_CHANNELS.map(channel => [channel, vi.fn(async () => channel)]),
    )

    registerTrustedIpcHandlers({
      ipcMain,
      handlers,
      getWindow: () => currentWindow,
      expectedUrl: fixture.expectedUrl,
    })

    expect([...registered.keys()]).toEqual(IPC_CHANNELS)
    await expect(registered.get('serial:list')(fixture.event)).rejects.toThrow('拒绝未授权')
    currentWindow = fixture.win
    await expect(registered.get('serial:list')(fixture.event)).resolves.toBe('serial:list')
  })

  it('缺少或多出通道时在启动阶段抛出中文配置错误', () => {
    const complete = Object.fromEntries(IPC_CHANNELS.map(channel => [channel, vi.fn()]))
    const missing = { ...complete }
    delete missing['save-image']
    const extra = { ...complete, 'unsafe:new': vi.fn() }
    const dependencies = {
      ipcMain: { handle: vi.fn() },
      getWindow: () => null,
      expectedUrl: 'file:///app/index.html',
    }

    expect(() => registerTrustedIpcHandlers({ ...dependencies, handlers: missing }))
      .toThrow('IPC 注册配置错误：缺少通道 save-image')
    expect(() => registerTrustedIpcHandlers({ ...dependencies, handlers: extra }))
      .toThrow('IPC 注册配置错误：存在未声明通道 unsafe:new')
  })
})
