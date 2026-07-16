// main/ipc-security.js — 所有高权限 IPC 共用的可信页面边界

const IPC_CHANNELS = Object.freeze([
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
  'points:export',
  'points:import',
  'copy-image',
  'read-image',
  'save-image',
])

function isDestroyed(target) {
  return typeof target?.isDestroyed === 'function' && target.isDestroyed()
}

function isTrustedAppFrame(event, win, expectedUrl) {
  if (!win || isDestroyed(win) || !win.webContents || isDestroyed(win.webContents)) {
    return false
  }

  return Boolean(
    event?.sender === win.webContents &&
    event.senderFrame === win.webContents.mainFrame &&
    event.senderFrame?.url === expectedUrl,
  )
}

function createTrustedIpcHandler({ channel, getWindow, expectedUrl, handler } = {}) {
  if (typeof channel !== 'string' || channel.length === 0) {
    throw new TypeError('IPC 安全配置错误：channel 必须是非空字符串')
  }
  if (typeof getWindow !== 'function') {
    throw new TypeError(`IPC 安全配置错误（通道：${channel}）：getWindow 必须是函数`)
  }
  if (typeof expectedUrl !== 'string' || expectedUrl.length === 0) {
    throw new TypeError(`IPC 安全配置错误（通道：${channel}）：expectedUrl 必须是非空字符串`)
  }
  if (typeof handler !== 'function') {
    throw new TypeError(`IPC 安全配置错误（通道：${channel}）：handler 必须是函数`)
  }

  return async (event, ...args) => {
    if (!isTrustedAppFrame(event, getWindow(), expectedUrl)) {
      throw new Error(
        `拒绝未授权的 IPC 请求（通道：${channel}）：仅允许当前应用窗口的可信主页面调用`,
      )
    }
    return handler(event, ...args)
  }
}

function registerTrustedIpcHandlers({ ipcMain, handlers, getWindow, expectedUrl } = {}) {
  if (typeof ipcMain?.handle !== 'function') {
    throw new TypeError('IPC 注册配置错误：ipcMain.handle 必须是函数')
  }
  if (!handlers || typeof handlers !== 'object' || Array.isArray(handlers)) {
    throw new TypeError('IPC 注册配置错误：handlers 必须是对象')
  }

  const missing = IPC_CHANNELS.filter(channel => typeof handlers[channel] !== 'function')
  if (missing.length > 0) {
    throw new Error(`IPC 注册配置错误：缺少通道 ${missing.join('、')}`)
  }
  const extra = Object.keys(handlers).filter(channel => !IPC_CHANNELS.includes(channel))
  if (extra.length > 0) {
    throw new Error(`IPC 注册配置错误：存在未声明通道 ${extra.join('、')}`)
  }

  for (const channel of IPC_CHANNELS) {
    ipcMain.handle(channel, createTrustedIpcHandler({
      channel,
      getWindow,
      expectedUrl,
      handler: handlers[channel],
    }))
  }
}

module.exports = {
  IPC_CHANNELS,
  isTrustedAppFrame,
  createTrustedIpcHandler,
  registerTrustedIpcHandlers,
}
