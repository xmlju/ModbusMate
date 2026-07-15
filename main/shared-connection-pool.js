// main/shared-connection-pool.js — 按连接参数复用底层 ModbusService
// 多个设备实例若连接参数完全一致（同一物理串口/TCP端点+从站ID），共享同一条底层连接，
// 而不是各自独立打开——RS485 等独占型物理连接不允许多个连接同时占用同一端口。
const { normalizeConnectionConfig } = require('./connection-config')

function connectionKey(cfg) {
  const p = normalizeConnectionConfig(cfg)
  return p.transport === 'tcp'
    ? `tcp|${p.host}|${p.port}|${p.unitId}|${p.timeout}`
    : `rtu|${p.serialPath}|${p.baudRate}|${p.dataBits}|${p.parity}|${p.stopBits}|${p.unitId}|${p.timeout}`
}

class SharedConnectionPool {
  constructor(createService) {
    this.createService = createService
    this.entries = new Map() // key -> { service, refCount, connectPromise, disconnectPromise, reconnectPromise }
  }

  // 句柄在调用方入队前创建，且立即同步创建一份备用 service（工厂同步失败需要同步抛出，
  // 与原有"服务在入队前创建"的调用方约定保持一致）。若该 key 已有共享连接，这份备用
  // service 不会被使用（未连接，无需清理）。
  createHandle(cfg) {
    const key = connectionKey(cfg)
    const preCreated = this.createService()
    return new SharedConnectionHandle(this, key, preCreated)
  }

  async _acquireAndConnect(key, cfg, preCreated) {
    let entry = this.entries.get(key)
    if (!entry) {
      entry = { service: preCreated, refCount: 0, connectPromise: null, disconnectPromise: null, reconnectPromise: null }
      this.entries.set(key, entry)
    }
    entry.refCount++
    if (!entry.connectPromise) {
      entry.connectPromise = entry.service.connect(cfg)
    }
    try {
      await entry.connectPromise
    } catch (err) {
      entry.connectPromise = null // 允许后续引用重新尝试连接
      await this._release(key, entry)
      throw err
    }
    return entry.service
  }

  async _release(key, entry) {
    entry.refCount--
    if (entry.refCount > 0) return
    try {
      await this._disconnectEntryOnce(entry)
      if (this.entries.get(key) === entry) this.entries.delete(key)
    } catch (err) {
      // 断开失败：恢复引用计数，允许调用方重试（镜像 DeviceManager._disconnectOnce 的语义）。
      entry.refCount++
      throw err
    }
  }

  _disconnectEntryOnce(entry) {
    if (!entry.disconnectPromise) {
      const disconnectPromise = Promise.resolve().then(() => entry.service.disconnect())
      entry.disconnectPromise = disconnectPromise
      disconnectPromise.then(
        () => {},
        () => {
          if (entry.disconnectPromise === disconnectPromise) entry.disconnectPromise = null
        },
      )
    }
    return entry.disconnectPromise
  }

  _reconnect(key) {
    const entry = this.entries.get(key)
    if (!entry) return Promise.reject(new Error('共享连接不存在，可能已被释放'))
    if (!entry.reconnectPromise) {
      entry.reconnectPromise = entry.service.reconnect().finally(() => {
        entry.reconnectPromise = null
      })
    }
    return entry.reconnectPromise
  }

  _connected(key) {
    return this.entries.get(key)?.service.connected === true
  }
}

class SharedConnectionHandle {
  constructor(pool, key, preCreated) {
    this.pool = pool
    this.key = key
    this.preCreated = preCreated
    this.service = null
    this.acquired = false
  }

  get connected() {
    return this.pool._connected(this.key)
  }

  async connect(cfg) {
    this.service = await this.pool._acquireAndConnect(this.key, cfg, this.preCreated)
    this.acquired = true
  }

  async disconnect() {
    if (!this.acquired) return
    const entry = this.pool.entries.get(this.key)
    if (!entry) { this.acquired = false; return }
    await this.pool._release(this.key, entry)
    this.acquired = false
  }

  reconnect() {
    return this.pool._reconnect(this.key)
  }

  read(area, addr, count) {
    if (!this.service) return Promise.reject(new Error('设备未连接'))
    return this.service.read(area, addr, count)
  }

  write(area, addr, words) {
    if (!this.service) return Promise.reject(new Error('设备未连接'))
    return this.service.write(area, addr, words)
  }
}

module.exports = { SharedConnectionPool, connectionKey }
