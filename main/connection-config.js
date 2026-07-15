// Modbus TCP/RTU 连接配置的默认值、规范化与边界校验

function parseInteger(value, defaultValue, label) {
  if (value === undefined) return defaultValue

  if (typeof value === 'number') {
    if (Number.isInteger(value)) return value
  } else if (typeof value === 'string') {
    const trimmed = value.trim()
    if (/^-?\d+$/.test(trimmed)) return Number(trimmed)
  }

  throw new Error(`${label} 必须是整数，仅接受数字或纯十进制整数字符串`)
}

function normalizeInteger(value, defaultValue, label, min, max) {
  const normalized = parseInteger(value, defaultValue, label)
  if (!Number.isInteger(normalized) || normalized < min || normalized > max) {
    throw new Error(`${label} 必须是 ${min} 到 ${max} 之间的整数`)
  }
  return normalized
}

function normalizeRequiredText(value, message) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(message)
  return value.trim()
}

function normalizeSerialPath(value) {
  if (typeof value !== 'string') {
    throw new Error('RTU 串口路径 serialPath 不能为空')
  }
  if (/[\u0000-\u001F\u007F-\u009F]/.test(value)) {
    throw new Error('RTU 串口路径 serialPath 不能包含换行、NUL 或其他控制字符')
  }
  if (value.trim() === '') {
    throw new Error('RTU 串口路径 serialPath 不能为空')
  }
  return value.trim()
}

function normalizeConnectionConfig(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('连接配置必须是对象')
  }

  const transport = raw.transport === undefined ? 'tcp' : raw.transport
  if (transport !== 'tcp' && transport !== 'rtu') {
    throw new Error(`未知连接类型 transport：${String(transport)}，仅支持 tcp 或 rtu`)
  }

  const unitId = transport === 'tcp'
    ? normalizeInteger(raw.unitId, 1, 'TCP 从站地址 unitId', 0, 255)
    : normalizeInteger(raw.unitId, 1, 'RTU 从站地址 unitId', 1, 247)
  const timeout = normalizeInteger(raw.timeout, 2000, '请求超时 timeout', 100, 60000)

  if (transport === 'tcp') {
    return {
      transport,
      host: normalizeRequiredText(raw.host, 'TCP 主机地址 host 不能为空'),
      port: normalizeInteger(raw.port, 502, 'TCP 端口 port', 1, 65535),
      unitId,
      timeout,
    }
  }

  const dataBits = parseInteger(raw.dataBits, 8, 'RTU 数据位 dataBits')
  if (dataBits !== 7 && dataBits !== 8) {
    throw new Error('RTU 数据位 dataBits 只能是 7 或 8')
  }

  const stopBits = parseInteger(raw.stopBits, 1, 'RTU 停止位 stopBits')
  if (stopBits !== 1 && stopBits !== 2) {
    throw new Error('RTU 停止位 stopBits 只能是 1 或 2')
  }

  const parity = raw.parity === undefined ? 'none' : raw.parity
  if (!['none', 'even', 'odd'].includes(parity)) {
    throw new Error('RTU 校验位 parity 只能是 none、even 或 odd')
  }

  return {
    transport,
    serialPath: normalizeSerialPath(raw.serialPath),
    baudRate: normalizeInteger(raw.baudRate, 9600, 'RTU 波特率 baudRate', 110, 4000000),
    dataBits,
    stopBits,
    parity,
    unitId,
    timeout,
  }
}

module.exports = { normalizeConnectionConfig }
