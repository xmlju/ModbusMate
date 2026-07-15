// Modbus 传输基类：统一连接生命周期、协议读写和错误提示
const ModbusRTU = require('modbus-serial')

const AREA_READERS = {
  coil: { fn: 'readCoils', isBit: true },
  discrete: { fn: 'readDiscreteInputs', isBit: true },
  holding: { fn: 'readHoldingRegisters', isBit: false },
  input: { fn: 'readInputRegisters', isBit: false },
}

// Modbus 异常码对应的中文现场提示
const EXCEPTION_HINTS = {
  1: '非法功能码：设备不支持该操作',
  2: '非法数据地址：设备不存在该地址，请检查起始地址和数量',
  3: '非法数据值：写入值不被设备接受',
  4: '设备故障：从站执行请求时发生不可恢复错误',
  6: '设备忙：从站正在处理其他命令，请稍后重试',
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

function friendly(err) {
  if (err?.modbusCode) {
    const hint = EXCEPTION_HINTS[err.modbusCode] || '未知异常'
    return createFriendlyError(`设备返回异常码 ${err.modbusCode}（${hint}）`, err)
  }
  if (/Timed out/i.test(err?.message || '')) {
    return createFriendlyError('请求超时：设备无响应，请检查网络和从站ID', err)
  }
  if (/Port Not Open/i.test(err?.message || '')) {
    return createFriendlyError('连接已断开', err)
  }
  return err
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
    try {
      await this.open(client, params)
      client.setID(params.unitId)
      client.setTimeout(params.timeout)

      this.client = client
      this.params = { ...params }
    } catch (err) {
      await this._cleanupFailedClient(client, err)
      throw err
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

    return this._enqueueOperation(() => this._readNow(reader, addr, count))
  }

  async _readNow(reader, addr, count) {
    try {
      const result = await this.client[reader.fn](addr, count)
      if (reader.isBit) {
        return result.data.slice(0, count).map(value => (value ? 1 : 0))
      }
      return Array.from(result.data)
    } catch (err) {
      throw friendly(err)
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

    return this._enqueueOperation(() => this._writeNow(area, addr, words))
  }

  async _writeNow(area, addr, words) {
    try {
      if (area === 'coil') {
        return await this.client.writeCoil(addr, words[0] === 1)
      }
      if (words.length === 1) {
        return await this.client.writeRegister(addr, words[0])
      }
      return await this.client.writeRegisters(addr, words)
    } catch (err) {
      throw friendly(err)
    }
  }
}

module.exports = { ModbusTransport, friendly }
