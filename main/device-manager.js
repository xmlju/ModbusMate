// main/device-manager.js — 多设备实例并发采集：每实例独立连接 + 轮询 + 断线自动重连
// 事件（均带实例 id）：data { id, blocks } / status { id, state } / pollError { id, message }
// 注意：错误事件命名为 pollError（EventEmitter 的 'error' 无监听会崩进程）
const { EventEmitter } = require('events')
const ModbusService = require('./modbus-service')

const OFFLINE_THRESHOLD = 3     // 连续失败次数判定断线
const RETRY_INTERVAL = 5000     // 重连间隔 ms

class DeviceManager extends EventEmitter {
  // createService 可注入（单测用 stub 替换真实 ModbusService）
  constructor(createService = () => new ModbusService()) {
    super()
    this.createService = createService
    this.instances = new Map()   // id → { service, cfg, timer, retryTimer, busy, failCount }
  }

  // cfg = { host, port, unitId, interval, blocks: [{ area, addr, count }] }
  async start(id, cfg) {
    await this.stop(id)
    const service = this.createService()
    const inst = { service, cfg, timer: null, retryTimer: null, busy: false, failCount: 0 }
    this.instances.set(id, inst)
    await service.connect(cfg)
    this.emit('status', { id, state: 'connected' })
    inst.timer = setInterval(() => this._tick(id), cfg.interval)
    this._tick(id)
  }

  async stop(id) {
    const inst = this.instances.get(id)
    if (!inst) return
    clearInterval(inst.timer)
    clearTimeout(inst.retryTimer)
    this.instances.delete(id)
    try { await inst.service.disconnect() } catch { /* 断开异常不影响停止流程 */ }
    this.emit('status', { id, state: 'disconnected' })
  }

  async stopAll() {
    for (const id of [...this.instances.keys()]) await this.stop(id)
  }

  write(id, area, addr, words) {
    const inst = this.instances.get(id)
    if (!inst) return Promise.reject(new Error('设备未连接，无法写入'))
    return inst.service.write(area, addr, words)
  }

  async _tick(id) {
    const inst = this.instances.get(id)
    if (!inst || inst.busy) return
    inst.busy = true
    try {
      const blocks = []
      for (const b of inst.cfg.blocks) {
        blocks.push({ ...b, values: await inst.service.read(b.area, b.addr, b.count) })
      }
      inst.failCount = 0
      this.emit('data', { id, blocks })
    } catch (err) {
      inst.failCount++
      this.emit('pollError', { id, message: err.message })
      if (inst.failCount >= OFFLINE_THRESHOLD) this._goOffline(id)
    } finally {
      inst.busy = false
    }
  }

  _goOffline(id) {
    const inst = this.instances.get(id)
    if (!inst) return
    clearInterval(inst.timer); inst.timer = null
    this.emit('status', { id, state: 'offline' })
    const retry = async () => {
      const cur = this.instances.get(id)
      if (!cur) return   // 已被 stop
      try {
        await cur.service.reconnect()
        cur.failCount = 0
        this.emit('status', { id, state: 'connected' })
        cur.timer = setInterval(() => this._tick(id), cur.cfg.interval)
        this._tick(id)
      } catch {
        cur.retryTimer = setTimeout(retry, RETRY_INTERVAL)
      }
    }
    inst.retryTimer = setTimeout(retry, RETRY_INTERVAL)
  }
}

module.exports = DeviceManager
