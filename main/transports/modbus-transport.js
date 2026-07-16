// Modbus 传输基类：统一连接生命周期、协议读写和错误提示
const ModbusRTU = require('modbus-serial')

const AREA_READERS = {
  coil: { fn: 'readCoils', isBit: true },
  discrete: { fn: 'readDiscreteInputs', isBit: true },
  holding: { fn: 'readHoldingRegisters', isBit: false },
  input: { fn: 'readInputRegisters', isBit: false },
}

const MAX_ADDRESS = 65535
const MAX_READ_COUNT = {
  coil: 2000,
  discrete: 2000,
  holding: 125,
  input: 125,
}
const MAX_WRITE_REGISTERS = 123
const SUPPORTED_RAW_FUNCTIONS = new Set([1, 2, 3, 4, 5, 6, 15, 16])

// 标准 Modbus 异常码（1~11 由规范定义，含义与厂商无关，全设备通用）
const STANDARD_EXCEPTION_HINTS = {
  1: '非法功能码：设备不支持该操作',
  2: '非法数据地址：设备不存在该地址，请检查起始地址和数量',
  3: '非法数据值：写入值超出范围或格式不被设备接受',
  4: '设备故障：从站执行请求时发生不可恢复错误',
  5: '设备已确认：正在处理该长耗时命令，请稍后查询结果',
  6: '设备忙：从站正在处理其他命令，请稍后重试',
  8: '存储奇偶校验错误：设备扩展存储区校验失败',
  10: '网关路径不可用：网关未配置到目标设备的路径',
  11: '网关目标无响应：网关已转发但目标设备未应答',
}

// 非标准异常码（0x0C=12 及以上）为厂商自定义，同一码不同厂商含义不同
// （如 0x0C 海索 PCS="需先关闭逆变"，吉事励直流电源="发生错误/开机禁止"），不能全局写死。
// 优先用设备类型自带的 exceptionHints 字典（随连接配置下发），查不到给中性提示引导查手册。
function hintForExceptionCode(code, params) {
  const custom = params && params.exceptionHints && params.exceptionHints[code]
  if (custom) return custom
  if (STANDARD_EXCEPTION_HINTS[code]) return STANDARD_EXCEPTION_HINTS[code]
  const hex = '0x' + Number(code).toString(16).toUpperCase().padStart(2, '0')
  return `厂商自定义异常码（${hex}）：含义因设备而异，请查阅该设备通讯手册`
}

function createFriendlyError(message, err) {
  const result = new Error(message, { cause: err })

  // 复制驱动附带的诊断信息，便于日志继续定位底层问题
  if (err && (typeof err === 'object' || typeof err === 'function')) {
    for (const key of Object.keys(err)) {
      if (key !== 'cause') result[key] = err[key]
    }
    if ('code' in err) result.code = err.code
    if ('modbusCode' in err) result.modbusCode = err.modbusCode
  }

  return result
}

function isTimeoutError(err) {
  return String(err?.code || '').toUpperCase() === 'ETIMEDOUT'
    || /timed?\s*out|timeout/i.test(err?.message || '')
}

function friendly(err, params = {}) {
  if (err?.modbusCode) {
    const hint = hintForExceptionCode(err.modbusCode, params)
    return createFriendlyError(`设备返回异常码 ${err.modbusCode}（${hint}）`, err)
  }
  if (isTimeoutError(err)) {
    if (params.transport === 'rtu') {
      return createFriendlyError(
        'RTU 请求超时：设备无响应，请检查 USB/RS485 接线、A/B 极性、波特率、数据位、校验位、停止位和从站 ID',
        err,
      )
    }
    return createFriendlyError('TCP 请求超时：设备无响应，请检查网络、设备地址、端口和从站 ID', err)
  }
  if (/Port Not Open/i.test(err?.message || '')) {
    return createFriendlyError('连接已断开', err)
  }
  return err
}

function sanitizeSingleLine(value, fallback = '') {
  return String(value || fallback)
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, '�')
    .replace(/\s+/g, ' ')
    .trim()
}

const PATH_PLACEHOLDER = '[本地路径已隐藏]'
const PATH_PREFIX_BOUNDARY = /[\s[({"'=,;]/
const PATH_END_PUNCTUATION = /[\])}"']/
const DIAGNOSTIC_CONNECTOR = /^\s+(?:and|because|but|while|when|after|before|failed|error|unable|cannot|retry)\b/i
const COMMA_DIAGNOSTIC = /^[,，]\s+(?:CRC|checksum|error|failed|failure|timeout|permission|connection|response|request|device|driver|status|code)\b/i

function hasPathPrefixBoundary(text, index) {
  return index === 0 || PATH_PREFIX_BOUNDARY.test(text[index - 1])
}

function followsFileUriScheme(text, index) {
  return text.slice(Math.max(0, index - 7), index).toLowerCase() === 'file://'
}

function pathKindAt(text, index) {
  const hasBoundary = hasPathPrefixBoundary(text, index)
  const followsFileUri = followsFileUriScheme(text, index)
  if (!hasBoundary && !followsFileUri) return null
  if (text[index] === '\\' && text[index + 1] === '\\') return 'unc'
  if (/[A-Za-z]/.test(text[index] || '') && text[index + 1] === ':' && /[\\/]/.test(text[index + 2] || '')) {
    return 'drive'
  }
  if (text[index] === '/') return 'posix'
  if (followsFileUri) return 'file-uri'
  return null
}

function enclosingPathCloser(text, start) {
  return {
    '[': ']',
    '(': ')',
    '{': '}',
    '"': '"',
    "'": "'",
  }[text[start - 1]] || null
}

function isDiagnosticConnectorAt(text, index, kind) {
  const match = DIAGNOSTIC_CONNECTOR.exec(text.slice(index))
  if (!match) return false

  // “and”等词也可能属于含空格的路径段；后面仍有路径分隔符时优先按路径处理，避免泄露后半段
  const remaining = text.slice(index + match[0].length)
  return kind === 'posix' ? !remaining.includes('/') : !/[\\/]/.test(remaining)
}

function isDiagnosticCommaAt(text, index, kind) {
  if (!COMMA_DIAGNOSTIC.test(text.slice(index))) return false
  const remaining = text.slice(index + 1)
  return kind === 'posix' ? !remaining.includes('/') : !/[\\/]/.test(remaining)
}

function findPathEnd(text, start, kind) {
  const pathPrefixLength = kind === 'drive' ? 3 : kind === 'unc' ? 2 : 1
  const enclosingCloser = enclosingPathCloser(text, start)
  if (enclosingCloser) {
    const closingIndex = text.indexOf(enclosingCloser, start + pathPrefixLength)
    if (closingIndex !== -1) return closingIndex
  }

  for (let index = start + pathPrefixLength; index < text.length; index += 1) {
    const char = text[index]
    if (PATH_END_PUNCTUATION.test(char)) return index
    if ((char === ',' || char === '，') && isDiagnosticCommaAt(text, index, kind)) return index
    if (isDiagnosticConnectorAt(text, index, kind)) return index
    if (char === ';' && isDiagnosticConnectorAt(text, index + 1, kind)) return index
  }
  return text.length
}

function redactLocalPaths(summary) {
  let result = ''
  let plainTextStart = 0
  let index = 0

  while (index < summary.length) {
    const kind = pathKindAt(summary, index)
    if (!kind) {
      index += 1
      continue
    }

    const end = findPathEnd(summary, index, kind)
    result += summary.slice(plainTextStart, index) + PATH_PLACEHOLDER
    plainTextStart = end
    index = end
  }

  return result + summary.slice(plainTextStart)
}

function sanitizeDiagnosticSummary(message, serialPath) {
  const pathToken = '__MODBUSMATE_SERIAL_PATH__'
  const rawSerialPath = String(serialPath || '')
  const safeSerialPath = sanitizeSingleLine(rawSerialPath)
  let summary = String(message || '未知底层错误')

  if (rawSerialPath) summary = summary.split(rawSerialPath).join(pathToken)
  summary = sanitizeSingleLine(summary, '未知底层错误')

  // 底层错误可能夹带配置文件等本地路径；仅保留本次诊断必需的串口路径
  summary = redactLocalPaths(summary).split(pathToken).join(safeSerialPath)

  return summary.length > 180 ? `${summary.slice(0, 180)}…` : summary
}

function classifySerialConnectionError(err) {
  const code = String(err?.code || '').toUpperCase()
  const message = String(err?.message || '')

  // 可靠的系统错误码优先，避免英文消息与 code 冲突时误判
  if (code === 'ENOENT' || code === 'ENODEV' || code === 'ENXIO') return 'missing'
  if (code === 'EACCES' || code === 'EPERM') return 'permission'
  if (code === 'EBUSY') return 'busy'

  if (/no such file|device not found|cannot find/i.test(message)) return 'missing'
  if (/permission denied|operation not permitted/i.test(message)) return 'permission'
  if (/resource busy|device.*busy|port.*busy/i.test(message)) return 'busy'
  if (/access denied/i.test(message)) return 'access-denied'
  if (/cannot open|could not open|failed to open/i.test(message)) return 'cannot-open'
  return 'other'
}

function friendlyConnection(err, params = {}, stage = 'open') {
  if (params.transport !== 'rtu') return err

  const serialPath = sanitizeSingleLine(params.serialPath, '未知端口')
  if (stage === 'setup') {
    const summary = sanitizeDiagnosticSummary(err?.message, params.serialPath)
    return createFriendlyError(
      `RTU 串口 ${serialPath} 已打开，但设置从站 ID 或超时失败：${summary}`,
      err,
    )
  }

  const category = classifySerialConnectionError(err)
  let hint

  if (category === 'missing') {
    hint = `RTU 串口 ${serialPath} 不存在或已拔出，请确认 USB/串口设备已连接且端口选择正确`
  } else if (category === 'permission') {
    hint = `RTU 串口 ${serialPath} 权限不足，请检查当前用户的串口访问权限`
  } else if (category === 'busy') {
    hint = `RTU 串口 ${serialPath} 被其他程序占用，请关闭其他串口调试工具后重试`
  } else if (category === 'access-denied') {
    hint = `RTU 串口 ${serialPath} 打开失败：Windows 下通常表示串口被占用或访问被拒绝，请关闭其他串口程序并检查权限`
  } else if (category === 'cannot-open') {
    hint = `RTU 串口 ${serialPath} 不存在、已拔出或无法打开，请重新选择端口并检查 USB 连接`
  } else {
    hint = `RTU 串口 ${serialPath} 打开失败：${sanitizeDiagnosticSummary(err?.message, params.serialPath)}`
  }

  return createFriendlyError(hint, err)
}

function normalizeCleanupError(value, message) {
  if (value instanceof Error) return value
  return new Error(message, { cause: value })
}

function runCleanup(client, method, failureMessage) {
  return new Promise((resolve, reject) => {
    try {
      client[method](result => {
        if (!result) return resolve()
        reject(normalizeCleanupError(result, failureMessage))
      })
    } catch (err) {
      reject(normalizeCleanupError(err, failureMessage))
    }
  })
}

function closeClient(client) {
  return runCleanup(client, 'close', '关闭连接失败')
}

function destroyClient(client) {
  return runCleanup(client, 'destroy', '销毁连接失败')
}

function validateAddress(addr) {
  if (typeof addr !== 'number' || !Number.isInteger(addr) || addr < 0 || addr > MAX_ADDRESS) {
    throw new Error(`addr 必须是 0..${MAX_ADDRESS} 范围内的整数，当前值: ${String(addr)}`)
  }
}

function crc16(bytes) {
  let crc = 0xFFFF
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) ? ((crc >>> 1) ^ 0xA001) : (crc >>> 1)
    }
  }
  return crc & 0xFFFF
}

function withCrc(bytes) {
  const body = Array.from(bytes)
  const crc = crc16(body)
  body.push(crc & 0xFF, (crc >>> 8) & 0xFF)
  return body
}

function hexBytes(bytes) {
  return Array.from(bytes).map(byte => Number(byte).toString(16).toUpperCase().padStart(2, '0')).join(' ')
}

function writeUInt16(bytes, value) {
  bytes.push((value >>> 8) & 0xFF, value & 0xFF)
}

function bytesToRegisters(values) {
  const result = []
  for (const value of values) writeUInt16(result, value)
  return result
}

function packBits(values) {
  const bytes = Array(Math.ceil(values.length / 8)).fill(0)
  values.forEach((value, index) => {
    if (value) bytes[Math.floor(index / 8)] |= 1 << (index % 8)
  })
  return bytes
}

function normalizeRawInteger(value, name, min, max) {
  const number = Number(value)
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${name} 必须是 ${min}..${max} 范围内的整数，当前值：${String(value)}`)
  }
  return number
}

function normalizeRawValues(values, name, maxLength, bit = false) {
  if (!Array.isArray(values) || values.length < 1 || values.length > maxLength) {
    throw new Error(`${name} 必须是长度 1..${maxLength} 的数组`)
  }
  return values.map((value, index) => {
    if (bit) {
      if (value !== 0 && value !== 1 && value !== false && value !== true) {
        throw new Error(`${name}[${index}] 必须是 0 或 1`)
      }
      return value === true || value === 1 ? 1 : 0
    }
    return normalizeRawInteger(value, `${name}[${index}]`, 0, MAX_ADDRESS)
  })
}

function normalizeRawRequest(request = {}) {
  if (request?.bytes !== undefined || request?.rawBytes !== undefined) {
    throw new Error('不允许输入裸字节流：请通过功能码、从站地址、起始地址、数量或写入值构造请求')
  }
  const unitId = normalizeRawInteger(request.unitId, '从站地址 unitId', 0, 255)
  const functionCode = normalizeRawInteger(request.functionCode, '功能码 functionCode', 1, 255)
  if (!SUPPORTED_RAW_FUNCTIONS.has(functionCode)) {
    throw new Error('仅支持功能码 01/02/03/04/05/06/0F/10 的表单构造请求')
  }
  const addr = normalizeRawInteger(request.addr, '起始地址 addr', 0, MAX_ADDRESS)
  return { ...request, unitId, functionCode, addr }
}

function validateReadPayload(area, addr, count) {
  validateAddress(addr)

  if (typeof count !== 'number' || !Number.isInteger(count)) {
    throw new Error(`count 必须是整数，当前值: ${String(count)}`)
  }

  const maxCount = MAX_READ_COUNT[area]
  if (count < 1 || count > maxCount) {
    throw new Error(`${area} 读取 count 必须在 1..${maxCount} 范围内，当前值: ${count}`)
  }
  if (addr + count - 1 > MAX_ADDRESS) {
    throw new Error(`读取地址跨度越界：addr + count - 1 不能超过 ${MAX_ADDRESS}（addr=${addr}, count=${count}）`)
  }
}

function validateAndSnapshotCoilWords(words) {
  if (!Array.isArray(words) || words.length !== 1) {
    throw new Error('coil words 必须是长度恰好为 1 的数组，元素只能是数值 0 或 1')
  }

  const snapshot = words.slice()
  if (snapshot[0] !== 0 && snapshot[0] !== 1) {
    throw new Error('coil words 必须是长度恰好为 1 的数组，元素只能是数值 0 或 1')
  }
  return snapshot
}

function validateAndSnapshotHoldingWords(addr, words) {
  if (!Array.isArray(words)) {
    throw new Error('holding words 必须是普通数组，不支持 TypedArray 或其他类型')
  }
  if (words.length < 1 || words.length > MAX_WRITE_REGISTERS) {
    throw new Error(`holding words 长度必须在 1..${MAX_WRITE_REGISTERS} 范围内，当前长度: ${words.length}`)
  }

  const snapshot = words.slice()
  const invalidIndex = snapshot.findIndex(value => (
    typeof value !== 'number'
    || !Number.isInteger(value)
    || value < 0
    || value > MAX_ADDRESS
  ))
  if (invalidIndex !== -1) {
    throw new Error(`holding words[${invalidIndex}] 必须是 0..${MAX_ADDRESS} 范围内的整数，当前值: ${String(snapshot[invalidIndex])}`)
  }
  if (addr + snapshot.length - 1 > MAX_ADDRESS) {
    throw new Error(`写入地址跨度越界：addr + words.length - 1 不能超过 ${MAX_ADDRESS}（addr=${addr}, words.length=${snapshot.length}）`)
  }
  return snapshot
}

class ModbusTransport {
  constructor(createClient = () => new ModbusRTU()) {
    this.createClient = createClient
    this.client = null
    this.params = null
    this._operationQueue = Promise.resolve()
  }

  get connected() {
    return this.client?.isOpen === true
  }

  async connect(params) {
    return this._enqueueOperation(() => this._connectNow(params))
  }

  async _connectNow(params) {
    await this._disconnectNow()

    const client = this.createClient()
    let opened = false
    try {
      await this.open(client, params)
      opened = true
      client.setID(params.unitId)
      client.setTimeout(params.timeout)

      this.client = client
      this.params = { ...params }
    } catch (err) {
      await this._cleanupFailedClient(client, err)
      throw friendlyConnection(err, params, opened ? 'setup' : 'open')
    }
  }

  async _cleanupFailedClient(client, connectionError) {
    try {
      if (client?.isOpen) {
        await closeClient(client)
      } else if (typeof client?.destroy === 'function') {
        await destroyClient(client)
      }
    } catch (cleanupError) {
      // 连接错误始终是主错误，清理失败作为附加诊断信息保留
      if (connectionError && typeof connectionError === 'object') {
        connectionError.cleanupError = cleanupError
      }
    }
  }

  async reconnect() {
    return this._enqueueOperation(async () => {
      if (!this.params) throw new Error('尚未配置过连接参数')
      await this._connectNow(this.params)
    })
  }

  async disconnect() {
    return this._enqueueOperation(() => this._disconnectNow())
  }

  async _disconnectNow() {
    const client = this.client
    if (!client) return

    if (client.isOpen) {
      await closeClient(client)
    }
    if (this.client === client) this.client = null
  }

  _enqueueOperation(operation) {
    const pending = this._operationQueue.then(operation)
    // 单次失败由调用者接收，但不阻塞后续操作
    this._operationQueue = pending.catch(() => {})
    return pending
  }

  async open() {
    throw new Error('未实现连接方式')
  }

  // 位区域统一转换为 0/1，寄存器统一转换为普通数组
  async read(area, addr, count) {
    const reader = AREA_READERS[area]
    if (!reader) throw new Error(`未知区域类型: ${area}`)
    validateReadPayload(area, addr, count)

    return this._enqueueOperation(() => this._readNow(reader, addr, count))
  }

  async _readNow(reader, addr, count) {
    if (!this.client || this.client.isOpen !== true) {
      throw new Error('设备未连接或连接已断开：无法执行 Modbus 读取')
    }

    try {
      const result = await this.client[reader.fn](addr, count)
      if (reader.isBit) {
        return result.data.slice(0, count).map(value => (value ? 1 : 0))
      }
      return Array.from(result.data)
    } catch (err) {
      throw friendly(err, this.params)
    }
  }

  // coil 使用 FC05；holding 单字使用 FC06，多字使用 FC16
  async write(area, addr, words) {
    if (area === 'input' || area === 'discrete') {
      throw new Error('该区域为只读，不支持写入')
    }
    if (area !== 'coil' && area !== 'holding') {
      throw new Error(`未知区域类型: ${area}`)
    }

    validateAddress(addr)
    const wordsSnapshot = area === 'coil'
      ? validateAndSnapshotCoilWords(words)
      : validateAndSnapshotHoldingWords(addr, words)

    return this._enqueueOperation(() => this._writeNow(area, addr, wordsSnapshot))
  }

  async _writeNow(area, addr, words) {
    if (!this.client || this.client.isOpen !== true) {
      throw new Error('设备未连接或连接已断开：无法执行 Modbus 写入')
    }

    try {
      if (area === 'coil') {
        return await this.client.writeCoil(addr, words[0] === 1)
      }
      if (words.length === 1) {
        return await this.client.writeRegister(addr, words[0])
      }
      return await this.client.writeRegisters(addr, words)
    } catch (err) {
      throw friendly(err, this.params)
    }
  }

  async rawRequest(request) {
    const normalized = normalizeRawRequest(request)
    return this._enqueueOperation(() => this._rawRequestNow(normalized))
  }

  async _rawRequestNow(request) {
    if (!this.client || this.client.isOpen !== true) {
      throw new Error('设备未连接或连接已断开：无法执行 Modbus 原始报文发送')
    }

    const previousUnitId = this.params?.unitId
    if (typeof this.client.setID === 'function') this.client.setID(request.unitId)
    try {
      const result = await this._executeRawRequest(request)
      if (previousUnitId !== undefined && previousUnitId !== request.unitId && typeof this.client.setID === 'function') {
        this.client.setID(previousUnitId)
      }
      return result
    } catch (err) {
      if (previousUnitId !== undefined && previousUnitId !== request.unitId && typeof this.client.setID === 'function') {
        try { this.client.setID(previousUnitId) } catch {}
      }
      throw friendly(err, this.params)
    }
  }

  async _executeRawRequest({ unitId, functionCode, addr, count, value, values }) {
    const tx = [unitId, functionCode]
    writeUInt16(tx, addr)

    if (functionCode >= 1 && functionCode <= 4) {
      const normalizedCount = normalizeRawInteger(count, '数量 count', 1, functionCode <= 2 ? 2000 : 125)
      if (addr + normalizedCount - 1 > MAX_ADDRESS) {
        throw new Error(`读取地址跨度越界：addr + count - 1 不能超过 ${MAX_ADDRESS}（addr=${addr}, count=${normalizedCount}）`)
      }
      writeUInt16(tx, normalizedCount)
      const method = { 1: 'readCoils', 2: 'readDiscreteInputs', 3: 'readHoldingRegisters', 4: 'readInputRegisters' }[functionCode]
      const response = await this.client[method](addr, normalizedCount)
      const data = functionCode <= 2
        ? packBits(Array.from(response.data).slice(0, normalizedCount).map(item => item ? 1 : 0))
        : bytesToRegisters(Array.from(response.data))
      return {
        tx: hexBytes(withCrc(tx)),
        rx: hexBytes(withCrc([unitId, functionCode, data.length, ...data])),
      }
    }

    if (functionCode === 5) {
      const bit = normalizeRawValues([value], '写入值 value', 1, true)[0]
      const encoded = bit ? 0xFF00 : 0x0000
      writeUInt16(tx, encoded)
      await this.client.writeCoil(addr, bit === 1)
      return {
        tx: hexBytes(withCrc(tx)),
        rx: hexBytes(withCrc(tx)),
      }
    }

    if (functionCode === 6) {
      const word = normalizeRawInteger(value, '写入值 value', 0, MAX_ADDRESS)
      writeUInt16(tx, word)
      await this.client.writeRegister(addr, word)
      return {
        tx: hexBytes(withCrc(tx)),
        rx: hexBytes(withCrc(tx)),
      }
    }

    if (functionCode === 15) {
      const bits = normalizeRawValues(values, '写入值 values', 1968, true)
      if (addr + bits.length - 1 > MAX_ADDRESS) {
        throw new Error(`写入地址跨度越界：addr + values.length - 1 不能超过 ${MAX_ADDRESS}（addr=${addr}, values.length=${bits.length}）`)
      }
      const data = packBits(bits)
      writeUInt16(tx, bits.length)
      tx.push(data.length, ...data)
      await this.client.writeCoils(addr, bits.map(bit => bit === 1))
      return {
        tx: hexBytes(withCrc(tx)),
        rx: hexBytes(withCrc([unitId, functionCode, (addr >>> 8) & 0xFF, addr & 0xFF, (bits.length >>> 8) & 0xFF, bits.length & 0xFF])),
      }
    }

    const words = normalizeRawValues(values, '写入值 values', MAX_WRITE_REGISTERS)
    if (addr + words.length - 1 > MAX_ADDRESS) {
      throw new Error(`写入地址跨度越界：addr + values.length - 1 不能超过 ${MAX_ADDRESS}（addr=${addr}, values.length=${words.length}）`)
    }
    const data = bytesToRegisters(words)
    writeUInt16(tx, words.length)
    tx.push(data.length, ...data)
    await this.client.writeRegisters(addr, words)
    return {
      tx: hexBytes(withCrc(tx)),
      rx: hexBytes(withCrc([unitId, functionCode, (addr >>> 8) & 0xFF, addr & 0xFF, (words.length >>> 8) & 0xFF, words.length & 0xFF])),
    }
  }
}

module.exports = { ModbusTransport, friendly }
