// renderer/connection-ui.js — 工作台 TCP/RTU 连接表单的纯函数
const ConnectionUI = (() => {
  const TRANSPORTS = new Set(['tcp', 'rtu'])
  const LEGACY_TRANSPORTS = new Set([undefined, null, '', 'legacy'])

  function normalizeTransport(value) {
    if (LEGACY_TRANSPORTS.has(value)) return 'tcp'
    if (TRANSPORTS.has(value)) return value
    throw new Error(`未知通信方式：${String(value)}，仅支持 TCP 或 RTU`)
  }

  function finiteNumber(value, fallback) {
    if (value === '' || value === undefined || value === null) return fallback
    const number = Number(value)
    return Number.isFinite(number) ? number : fallback
  }

  function normalizeConnectionView(config = {}) {
    const transport = normalizeTransport(config.transport)
    return {
      transport,
      host: typeof config.host === 'string' ? config.host.trim() : '',
      port: finiteNumber(config.port, 502),
      serialPath: typeof config.serialPath === 'string' ? config.serialPath.trim() : '',
      baudRate: finiteNumber(config.baudRate, 9600),
      dataBits: finiteNumber(config.dataBits, 8),
      parity: ['none', 'even', 'odd'].includes(config.parity) ? config.parity : 'none',
      stopBits: finiteNumber(config.stopBits, 1),
      unitId: finiteNumber(config.unitId, 1),
      timeout: finiteNumber(config.timeout, 2000),
    }
  }

  function requiredInteger(value, emptyMessage, invalidMessage, fallback) {
    if (value === undefined) return fallback
    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (!trimmed) throw new Error(emptyMessage)
      if (/^-?\d+$/.test(trimmed)) return Number(trimmed)
      throw new Error(invalidMessage)
    }
    if (typeof value === 'number' && Number.isInteger(value)) return value
    throw new Error(invalidMessage)
  }

  function requireIntegerInRange(value, min, max, message) {
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(message)
    return value
  }

  function buildConnectionConfig(values = {}) {
    const transport = normalizeTransport(values.transport)
    const unitId = requiredInteger(values.unitId, '从站地址不能为空', '从站地址必须是整数', 1)
    const timeout = requiredInteger(values.timeout, '超时时间不能为空', '超时时间必须是整数', 2000)
    const common = {
      unitId: requireIntegerInRange(
        unitId,
        transport === 'rtu' ? 1 : 0,
        transport === 'rtu' ? 247 : 255,
        transport === 'rtu' ? 'RTU 从站地址必须是 1 到 247 之间的整数' : 'TCP 从站地址必须是 0 到 255 之间的整数',
      ),
      timeout: requireIntegerInRange(timeout, 100, 60000, '超时时间必须是 100 到 60000 之间的整数'),
    }

    if (transport === 'tcp') {
      const host = typeof values.host === 'string' ? values.host.trim() : ''
      if (!host) throw new Error('TCP 主机地址不能为空')
      const port = requiredInteger(values.port, 'TCP 端口不能为空', 'TCP 端口必须是整数', 502)
      return {
        transport,
        host,
        port: requireIntegerInRange(port, 1, 65535, 'TCP 端口必须是 1 到 65535 之间的整数'),
        ...common,
      }
    }

    const serialPath = typeof values.serialPath === 'string' ? values.serialPath.trim() : ''
    if (!serialPath) throw new Error('请选择串口')
    if (/[\u0000-\u001F\u007F-\u009F]/.test(serialPath)) throw new Error('RTU 串口路径不能包含控制字符')
    const baudRate = requiredInteger(values.baudRate, '波特率不能为空', '波特率必须是整数', 9600)
    const dataBits = requiredInteger(values.dataBits, '数据位不能为空', '数据位必须是整数', 8)
    const stopBits = requiredInteger(values.stopBits, '停止位不能为空', '停止位必须是整数', 1)
    const parity = values.parity === undefined ? 'none' : values.parity
    if (dataBits !== 7 && dataBits !== 8) throw new Error('RTU 数据位只能是 7 或 8')
    if (stopBits !== 1 && stopBits !== 2) throw new Error('RTU 停止位只能是 1 或 2')
    if (!['none', 'even', 'odd'].includes(parity)) throw new Error('RTU 校验位只能是 none、even 或 odd')
    return {
      transport,
      serialPath,
      baudRate: requireIntegerInRange(baudRate, 110, 4000000, 'RTU 波特率必须是 110 到 4000000 之间的整数'),
      dataBits,
      parity,
      stopBits,
      ...common,
    }
  }

  function display(value) {
    return value === undefined || value === null || value === '' ? '—' : String(value)
  }

  function formatConnectionTarget(config = {}) {
    const transport = normalizeTransport(config.transport)
    if (transport === 'tcp') {
      return `TCP · ${display(config.host)}:${display(config.port)} · ID ${display(config.unitId)}`
    }
    const parity = { none: 'N', even: 'E', odd: 'O' }[config.parity] || '—'
    return `RTU · ${display(config.serialPath)} · ${display(config.baudRate)} ${display(config.dataBits)}${parity}${display(config.stopBits)} · ID ${display(config.unitId)}`
  }

  function safeText(value) {
    return typeof value === 'string' ? value : ''
  }

  function mergeSerialPortOptions(current, ports) {
    const result = []
    const seen = new Set()
    for (const raw of Array.isArray(ports) ? ports : []) {
      const path = safeText(raw?.path).trim()
      if (!path || seen.has(path)) continue
      seen.add(path)
      result.push({
        path,
        manufacturer: safeText(raw.manufacturer),
        vendorId: safeText(raw.vendorId),
        productId: safeText(raw.productId),
        unavailable: false,
      })
    }
    const currentPath = safeText(current).trim()
    if (currentPath && !seen.has(currentPath)) {
      result.push({ path: currentPath, manufacturer: '', vendorId: '', productId: '', unavailable: true })
    }
    return result
  }

  function serialPortLabel(port = {}) {
    const path = safeText(port.path)
    if (port.unavailable) return `${path}（当前不可用）`
    const details = [
      safeText(port.manufacturer),
      port.vendorId ? `VID ${safeText(port.vendorId)}` : '',
      port.productId ? `PID ${safeText(port.productId)}` : '',
    ].filter(Boolean)
    return details.length ? `${path} · ${details.join(' · ')}` : path
  }

  function mergeConnectionIntoConfig(existing, connection) {
    return { ...(existing || {}), ...(connection || {}) }
  }

  function createSerialPortLoader(listPorts) {
    if (typeof listPorts !== 'function') throw new Error('串口刷新器配置错误：listPorts 必须是函数')
    let pending = null
    return {
      load() {
        if (pending) return pending
        try {
          pending = Promise.resolve(listPorts()).finally(() => { pending = null })
        } catch (error) {
          pending = Promise.reject(error).finally(() => { pending = null })
        }
        return pending
      },
      isLoading() { return pending !== null },
    }
  }

  function createExclusiveRunner() {
    let pending = null
    return {
      run(action) {
        if (pending) return pending
        if (typeof action !== 'function') return Promise.reject(new Error('独占操作必须是函数'))
        try {
          pending = Promise.resolve(action()).finally(() => { pending = null })
        } catch (error) {
          pending = Promise.reject(error).finally(() => { pending = null })
        }
        return pending
      },
      isRunning() { return pending !== null },
    }
  }

  return {
    normalizeTransport,
    normalizeConnectionView,
    buildConnectionConfig,
    formatConnectionTarget,
    mergeSerialPortOptions,
    serialPortLabel,
    mergeConnectionIntoConfig,
    createSerialPortLoader,
    createExclusiveRunner,
  }
})()

if (typeof window !== 'undefined') window.ConnectionUI = ConnectionUI
if (typeof module !== 'undefined' && module.exports) module.exports = ConnectionUI
