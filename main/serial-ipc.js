// main/serial-ipc.js — 可独立测试的串口 IPC 安全边界
const { listSerialPorts } = require('./serial-ports')

function createSerialListHandler(list = listSerialPorts) {
  return async event => {
    if (!event?.senderFrame?.url?.startsWith('file://')) {
      throw new Error('拒绝未授权的串口枚举请求')
    }

    try {
      return { ok: true, ports: await list() }
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

module.exports = { createSerialListHandler }
