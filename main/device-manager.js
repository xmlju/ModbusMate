// main/device-manager.js — 多设备实例并发采集：每实例独立连接 + 轮询 + 断线自动重连
// 事件（均带实例 id）：data { id, blocks } / status { id, state } / pollError { id, message }
// 注意：错误事件命名为 pollError（EventEmitter 的 'error' 无监听会崩进程）
const { EventEmitter } = require('events')
const ModbusService = require('./modbus-service')
const { SharedConnectionPool } = require('./shared-connection-pool')

const OFFLINE_THRESHOLD = 3     // 连续失败次数判定断线
const RETRY_INTERVAL = 5000     // 重连间隔 ms
// 同一轮里连续读取多个数据块时，块之间的最小间隔（ms）。
// 部分 RTU 从站要求主机轮询间隔不小于一定字节时间（如 HS-ESS/PCS 要求 200 字节时间，
// 9600 波特率下约 208ms），连续背靠背发送请求会导致从站来不及应答而大面积超时。
const DEFAULT_BLOCK_GAP = 250

class DeviceManager extends EventEmitter {
  // createService 可注入（单测用 stub 替换真实 ModbusService）。
  // 连接参数完全相同的实例（同一物理串口/TCP端点+从站ID）通过连接池共享底层连接，
  // 避免 RS485 等独占型端口被多个实例并发打开。
  constructor(createService = () => new ModbusService()) {
    super()
    this.createService = createService
    this.pool = new SharedConnectionPool(createService)
    this.instances = new Map()
    this.generations = new Map()       // id → 当前操作代次；调用 start/stop 时立即更新
    this.lifecycleQueues = new Map()   // id → 生命周期 FIFO 队尾 Promise
  }

  // cfg = { host, port, unitId, interval, blocks: [{ area, addr, count }] }
  start(id, cfg) {
    const previousGeneration = this.generations.get(id)
    const generation = this._nextGeneration(id)
    // 句柄在入队前创建，让并发 start 各自拥有且最终清理自己的资源；
    // 是否与其他实例共享底层连接由连接池按连接参数决定，句柄接口与独立 service 一致。
    let service
    try {
      service = this.pool.createHandle(cfg)
    } catch (err) {
      // 工厂同步失败尚未进入队列：若旧实例/意图存在则恢复旧代，空 manager 才删除。
      // 若工厂内部已触发更新一代，则不能覆盖那一代的 intent。
      if (this.generations.get(id) === generation) {
        if (previousGeneration === undefined) this.generations.delete(id)
        else this.generations.set(id, previousGeneration)
      }
      throw err
    }
    const inst = {
      service,
      cfg,
      generation,
      timer: null,
      retryTimer: null,
      tickPromise: null,
      reconnectPromise: null,
      disconnectPromise: null,
      busy: false,
      failCount: 0,
      stopped: false,
      connectedEmitted: false,
      disconnectedEmitted: false,
    }

    return this._enqueueLifecycle(id, async () => {
      // 排队期间已经被后续 start/stop 淘汰，未连接的服务也要释放。
      if (!this._isGenerationCurrent(id, generation)) {
        await this._discardUnstarted(inst)
        return
      }

      const previous = this.instances.get(id)
      if (previous) {
        try {
          await this._stopInstance(id, previous, true)
        } catch (err) {
          // 旧服务无法关闭时不能继续连接新服务，未启动的新服务也要释放。
          await this._discardUnstarted(inst)
          throw err
        }
      }

      if (!this._isGenerationCurrent(id, generation)) {
        await this._discardUnstarted(inst)
        return
      }

      this.instances.set(id, inst)
      try {
        await service.connect(cfg)
      } catch (err) {
        await this._cleanupFailedStart(id, inst, err)
        throw err
      }

      // connect 是异步边界：成功并不代表本次 start 仍是当前意图。
      if (!this._isCurrent(id, inst)) {
        await this._disposeInstance(id, inst)
        return
      }

      inst.connectedEmitted = true
      this.emit('status', { id, state: 'connected' })
      // status 监听器也可能同步调用 stop/start，因此发事件后再次确认身份。
      if (!this._isCurrent(id, inst)) return

      inst.timer = setInterval(() => this._tick(id), cfg.interval)
      if (this._isCurrent(id, inst)) this._tick(id)
    })
  }

  stop(id) {
    const generation = this._nextGeneration(id)
    return this._enqueueLifecycle(id, async () => {
      const inst = this.instances.get(id)
      if (inst) await this._stopInstance(id, inst, true)
      if (this.generations.get(id) === generation && !this.instances.has(id)) {
        this.generations.delete(id)
      }
    })
  }

  async stopAll() {
    // lifecycleQueues 还包含尚未写入 instances 的 pending start。
    const ids = new Set([...this.instances.keys(), ...this.lifecycleQueues.keys()])
    await Promise.all([...ids].map(id => this.stop(id)))
  }

  write(id, area, addr, words) {
    const inst = this.instances.get(id)
    if (!inst || !this._isCurrent(id, inst)) return Promise.reject(new Error('设备未连接，无法写入'))
    return inst.service.write(area, addr, words)
  }

  _nextGeneration(id) {
    const generation = (this.generations.get(id) || 0) + 1
    this.generations.set(id, generation)
    return generation
  }

  _isGenerationCurrent(id, generation) {
    return this.generations.get(id) === generation
  }

  _isCurrent(id, inst) {
    return this.instances.get(id) === inst &&
      this._isGenerationCurrent(id, inst.generation) &&
      !inst.stopped
  }

  _enqueueLifecycle(id, operation) {
    const previous = this.lifecycleQueues.get(id)
    let current
    if (previous) {
      // 前一个操作失败只影响它自己的调用者，不能毒化后续队列。
      current = previous.catch(() => {}).then(operation)
    } else {
      try {
        current = Promise.resolve(operation())
      } catch (err) {
        current = Promise.reject(err)
      }
    }
    this.lifecycleQueues.set(id, current)

    const clearQueue = () => {
      if (this.lifecycleQueues.get(id) === current) this.lifecycleQueues.delete(id)
    }
    current.then(clearQueue, clearQueue)
    return current
  }

  async _cleanupFailedStart(id, inst, originalError) {
    try {
      await this._disposeInstance(id, inst)
    } catch (cleanupError) {
      // start 失败必须从 Map 清除，即使端口清理本身也失败。
      if (this.instances.get(id) === inst) this.instances.delete(id)
      // 保留 connect 的原始异常，同时提供清理异常用于诊断端口释放失败。
      if (originalError && (typeof originalError === 'object' || typeof originalError === 'function')) {
        originalError.cleanupError = cleanupError
      }
    } finally {
      // 只清除本次失败 start 自己的 intent；后续 start/stop 的更新代不可误删。
      if (this.generations.get(id) === inst.generation && !this.instances.has(id)) {
        this.generations.delete(id)
      }
    }
  }

  async _discardUnstarted(inst) {
    inst.stopped = true
    try { await this._disconnectOnce(inst) } catch { /* 被淘汰实例的清理异常不覆盖当前意图 */ }
  }

  async _stopInstance(id, inst, emitStatus) {
    // disconnect 失败必须由 stop 调用者感知；只有成功后才能报告已断开。
    await this._disposeInstance(id, inst)

    if (emitStatus && inst.connectedEmitted && !inst.disconnectedEmitted) {
      inst.disconnectedEmitted = true
      this.emit('status', { id, state: 'disconnected' })
    }
  }

  async _disposeInstance(id, inst) {
    inst.stopped = true
    clearInterval(inst.timer)
    clearTimeout(inst.retryTimer)
    inst.timer = null
    inst.retryTimer = null

    // 先让在途 I/O 收敛，再断开服务，避免 reconnect 在 disconnect 后复活端口。
    const pending = [inst.tickPromise, inst.reconnectPromise].filter(Boolean)
    if (pending.length) await Promise.allSettled(pending)

    // disconnect 失败时保留 Map 引用，允许后续 stop 再次尝试。
    await this._disconnectOnce(inst)
    if (this.instances.get(id) === inst) this.instances.delete(id)
  }

  _disconnectOnce(inst) {
    if (!inst.disconnectPromise) {
      const disconnectPromise = Promise.resolve().then(() => inst.service.disconnect())
      inst.disconnectPromise = disconnectPromise
      disconnectPromise.then(
        () => {},
        () => {
          // 失败结果不能永久缓存，否则第二次 stop 无法真正重试。
          if (inst.disconnectPromise === disconnectPromise) inst.disconnectPromise = null
        },
      )
    }
    return inst.disconnectPromise
  }

  _tick(id) {
    const inst = this.instances.get(id)
    if (!inst || inst.busy || !this._isCurrent(id, inst)) return Promise.resolve()

    const tickPromise = this._runTick(id, inst)
    inst.tickPromise = tickPromise
    const clearTick = () => {
      if (inst.tickPromise === tickPromise) inst.tickPromise = null
    }
    tickPromise.then(clearTick, clearTick)
    return tickPromise
  }

  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  async _runTick(id, inst) {
    inst.busy = true
    try {
      const blocks = []
      const list = inst.cfg.blocks
      // 块间间隔：cfg.blockGap 可覆盖，缺省用 DEFAULT_BLOCK_GAP；设为 0 可关闭
      const gap = inst.cfg.blockGap != null ? inst.cfg.blockGap : DEFAULT_BLOCK_GAP
      for (let i = 0; i < list.length; i++) {
        const b = list[i]
        const values = await inst.service.read(b.area, b.addr, b.count)
        if (!this._isCurrent(id, inst)) return
        blocks.push({ ...b, values })
        // 仅在块之间插入间隔（最后一块之后不需要），满足从站最小轮询间隔要求
        if (gap > 0 && i < list.length - 1) {
          await this._delay(gap)
          if (!this._isCurrent(id, inst)) return
        }
      }
      if (!this._isCurrent(id, inst)) return
      inst.failCount = 0
      this.emit('data', { id, blocks })
    } catch (err) {
      if (!this._isCurrent(id, inst)) return
      inst.failCount++
      this.emit('pollError', { id, message: err.message })
      // pollError 监听器可能同步停止实例。
      if (this._isCurrent(id, inst) && inst.failCount >= OFFLINE_THRESHOLD) this._goOffline(id, inst)
    } finally {
      inst.busy = false
    }
  }

  _goOffline(id, inst = this.instances.get(id)) {
    if (!inst || !this._isCurrent(id, inst)) return
    clearInterval(inst.timer)
    inst.timer = null
    this.emit('status', { id, state: 'offline' })
    if (this._isCurrent(id, inst)) this._scheduleRetry(id, inst)
  }

  _scheduleRetry(id, inst) {
    if (!this._isCurrent(id, inst)) return
    inst.retryTimer = setTimeout(() => {
      inst.retryTimer = null
      if (!this._isCurrent(id, inst)) return

      const reconnectPromise = (async () => {
        try {
          await inst.service.reconnect()
          if (!this._isCurrent(id, inst)) return
          inst.failCount = 0
          this.emit('status', { id, state: 'connected' })
          if (!this._isCurrent(id, inst)) return
          inst.timer = setInterval(() => this._tick(id), inst.cfg.interval)
          if (this._isCurrent(id, inst)) this._tick(id)
        } catch {
          if (this._isCurrent(id, inst)) this._scheduleRetry(id, inst)
        }
      })()

      inst.reconnectPromise = reconnectPromise
      const clearReconnect = () => {
        if (inst.reconnectPromise === reconnectPromise) inst.reconnectPromise = null
      }
      reconnectPromise.then(clearReconnect, clearReconnect)
    }, RETRY_INTERVAL)
  }
}

module.exports = DeviceManager
