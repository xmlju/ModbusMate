// Modbus TCP/RTU 统一服务入口：负责配置规范化与传输生命周期编排
const { normalizeConnectionConfig } = require('./connection-config')
const { createTransport } = require('./transports/factory')

class ModbusService {
  constructor(factory = createTransport) {
    this.factory = factory
    this.transport = null
    this.params = null
  }

  get connected() {
    return this.transport?.connected === true
  }

  async connect(raw) {
    // 必须先校验新配置，避免错误输入断开当前正常连接
    const params = normalizeConnectionConfig(raw)

    await this.disconnect()

    const transport = this.factory(params)
    await transport.connect(params)

    // 连接完全成功后才对外发布，避免暴露半连接或失败的实例
    this.transport = transport
    this.params = params
  }

  async reconnect() {
    if (!this.transport || !this.params) {
      throw new Error('尚未配置过连接参数')
    }
    return this.transport.reconnect()
  }

  async disconnect() {
    const transport = this.transport
    if (!transport) return

    await transport.disconnect()
    if (this.transport === transport) this.transport = null
  }

  async read(area, addr, count) {
    if (!this.transport) throw new Error('设备未连接')
    return this.transport.read(area, addr, count)
  }

  async write(area, addr, words) {
    if (!this.transport) throw new Error('设备未连接')
    return this.transport.write(area, addr, words)
  }
}

module.exports = ModbusService
