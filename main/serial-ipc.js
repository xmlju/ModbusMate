// main/serial-ipc.js — 可独立测试的串口 IPC 安全边界

function isTrustedAppFrame(event, win, expectedUrl) {
  return Boolean(
    win &&
    event?.sender === win.webContents &&
    event.senderFrame === win.webContents.mainFrame &&
    event.senderFrame.url === expectedUrl,
  )
}

function createSerialListHandler({ listPorts, isTrustedEvent } = {}) {
  if (typeof listPorts !== 'function') {
    throw new TypeError('串口 IPC 配置错误：listPorts 必须是函数')
  }
  if (typeof isTrustedEvent !== 'function') {
    throw new TypeError('串口 IPC 配置错误：isTrustedEvent 必须是函数')
  }

  return async event => {
    if (!isTrustedEvent(event)) {
      throw new Error('拒绝未授权的串口枚举请求')
    }

    try {
      return { ok: true, ports: await listPorts() }
    } catch (error) {
      return {
        ok: false,
        error: {
          message: error instanceof Error ? error.message : String(error),
          code: error?.code,
          causeMessage: error?.cause instanceof Error
            ? error.cause.message
            : error?.cause === undefined ? '' : String(error.cause),
        },
      }
    }
  }
}

module.exports = { createSerialListHandler, isTrustedAppFrame }
