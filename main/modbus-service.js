// Modbus TCP/RTU 统一服务入口：负责配置规范化与传输生命周期编排
const { normalizeConnectionConfig } = require('./connection-config')
const { createTransport } = require('./transports/factory')

class ModbusService {
  constructor(factory = createTransport) {
    this.factory = factory
    this.transport = null
    this.params = null
    this._operationQueue = Promise.resolve()
  }

  get connected() {
    return this.transport?.connected === true
  }

  connect(raw) {
    // 必须先校验新配置，避免错误输入断开当前正常连接
    let params
    try {
      params = normalizeConnectionConfig(raw)
    } catch (err) {
      return Promise.reject(err)
    }

    return this._enqueueOperation(() => this._connectNow(params))
  }

  async _connectNow(params) {
    await this._disconnectNow()

    const transport = this.factory(params)
    await transport.connect(params)

    // 连接完全成功后才对外发布，避免暴露半连接或失败的实例
    this.transport = transport
    this.params = params
  }

  reconnect() {
    return this._enqueueOperation(() => this._reconnectNow())
  }

  async _reconnectNow() {
    if (!this.transport || !this.params) {
      throw new Error('尚未配置过连接参数')
    }
    return this.transport.reconnect()
  }

  disconnect() {
    return this._enqueueOperation(() => this._disconnectNow())
  }

  async _disconnectNow() {
    const transport = this.transport
    if (!transport) return

    await transport.disconnect()
    if (this.transport === transport) this.transport = null
  }

  _enqueueOperation(operation) {
    const pending = this._operationQueue.then(operation)
    // 当前调用的错误交给调用者，队列本身恢复后继续执行后续操作
    this._operationQueue = pending.catch(() => {})
    return pending
  }

  read(area, addr, count) {
    return this._enqueueOperation(() => this._readNow(area, addr, count))
  }

  async _readNow(area, addr, count) {
    if (!this.transport) throw new Error('设备未连接')
    return this.transport.read(area, addr, count)
  }

  write(area, addr, words) {
    return this._enqueueOperation(() => this._writeNow(area, addr, words))
  }

  async _writeNow(area, addr, words) {
    if (!this.transport) throw new Error('设备未连接')
    return this.transport.write(area, addr, words)
  }
}

module.exports = ModbusService
