// main/poller.js — 轮询调度 + 写入优先队列 + 断线自动重连
// 事件：data { area, addr, values } / pollError (message) / offline / online
// 注意：错误事件命名为 pollError（EventEmitter 的 'error' 无监听会崩进程）
const { EventEmitter } = require('events')

const OFFLINE_THRESHOLD = 3     // 连续失败次数判定断线
const RETRY_INTERVAL = 5000     // 重连间隔 ms

class Poller extends EventEmitter {
  constructor(service) {
    super()
    this.service = service
    this.config = null           // { area, addr, count, interval }
    this.timer = null
    this.retryTimer = null
    this.failCount = 0
    this.writeQueue = []
    this.busy = false            // 一次只允许一个在途请求（Modbus 串行）
  }

  get running() { return this.timer !== null }

  start(config) {
    this.stop()
    this.config = config
    this.failCount = 0
    this.timer = setInterval(() => this._tick(), config.interval)
    this._tick()
  }

  stop() {
    clearInterval(this.timer); this.timer = null
    clearTimeout(this.retryTimer); this.retryTimer = null
  }

  // 写入请求：优先于轮询执行，完成后立即触发一次读回
  write(area, addr, words) {
    const job = new Promise((resolve, reject) => {
      this.writeQueue.push({ area, addr, words, resolve, reject })
    })
    if (!this.busy) {
      this._flushWrites().then(() => { if (this.running) this._tick() })
    }
    return job
  }

  async _flushWrites() {
    while (this.writeQueue.length > 0) {
      const w = this.writeQueue.shift()
      try {
        await this.service.write(w.area, w.addr, w.words)
        w.resolve()
      } catch (err) { w.reject(err) }
    }
  }

  async _tick() {
    if (this.busy || !this.config) return
    this.busy = true
    try {
      const { area, addr, count } = this.config
      const values = await this.service.read(area, addr, count)
      this.failCount = 0
      this.emit('data', { area, addr, values })
      await this._flushWrites()   // 读的间隙处理排队的写
    } catch (err) {
      this.failCount++
      this.emit('pollError', err.message)
      if (this.failCount >= OFFLINE_THRESHOLD) this._goOffline()
    } finally {
      this.busy = false
    }
  }

  _goOffline() {
    clearInterval(this.timer); this.timer = null
    this.emit('offline')
    const retry = async () => {
      try {
        await this.service.reconnect()
        this.emit('online')
        if (this.config) this.start(this.config)   // 恢复后自动继续监控
      } catch {
        this.retryTimer = setTimeout(retry, RETRY_INTERVAL)
      }
    }
    this.retryTimer = setTimeout(retry, RETRY_INTERVAL)
  }
}

module.exports = Poller
