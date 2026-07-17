// main/web-runtime.js — 与 Electron/HTTP 无关的 Modbus 业务运行时
const { EventEmitter } = require('events')
const path = require('path')
const ModbusService = require('./modbus-service')
const Poller = require('./poller')
const DeviceManager = require('./device-manager')
const { listSerialPorts: defaultListSerialPorts } = require('./serial-ports')
const { createConfigStore } = require('./config-store')
const { createLlmService } = require('./llm/llm-service')

const WEB_RUNTIME_CHANNELS = Object.freeze([
  'serial:list',
  'modbus:connect',
  'modbus:disconnect',
  'modbus:startPoll',
  'modbus:stopPoll',
  'modbus:write',
  'modbus:rawRequest',
  'config:load',
  'config:save',
  'device:start',
  'device:stop',
  'device:write',
  'device:rawFrame',
  'llm:extractText',
  'llm:extractPoints',
  'llm:testConnection',
  'llm:getQuota',
])

function serializableError(error) {
  const source = error instanceof Error ? error : new Error(String(error))
  const cause = source.cause
  const causeDetails = cause === undefined
    ? undefined
    : {
        message: cause instanceof Error ? cause.message : String(cause),
        ...(cause?.code === undefined ? {} : { code: cause.code }),
      }
  const wrapped = new Error(source.message)

  Object.defineProperty(wrapped, 'message', {
    value: source.message,
    enumerable: true,
    configurable: true,
  })
  const code = source.code ?? cause?.code
  if (code !== undefined) wrapped.code = code
  if (causeDetails !== undefined) wrapped.cause = causeDetails
  if (source.stack) wrapped.stack = source.stack
  return wrapped
}

class WebRuntime extends EventEmitter {
  constructor({ service, poller, deviceManager, configStore, listSerialPorts, llmService }) {
    super()
    this.service = service
    this.poller = poller
    this.deviceManager = deviceManager
    this.configStore = configStore
    this.listSerialPorts = listSerialPorts
    this.llmService = llmService
    this._sourceListeners = []
    this._closing = false
    this._closePromise = null

    // 无原型表避免 toString/constructor/__proto__ 被当作已注册通道。
    this._handlers = Object.assign(Object.create(null), {
      'serial:list': async () => {
        try {
          const ports = await this.listSerialPorts()
          if (!Array.isArray(ports)) {
            const actualType = ports === null ? 'null' : typeof ports
            const cause = new TypeError(`串口枚举接口实际类型为 ${actualType}`)
            throw new Error('串口枚举结果无效：必须返回端口数组', { cause })
          }
          return ports
        } catch (error) {
          throw serializableError(error)
        }
      },
      'modbus:connect': async params => {
        await this.service.connect(params)
        this._forward('modbus:status', { state: 'connected' })
      },
      'modbus:disconnect': async () => {
        await this.poller.stop()
        await this.service.disconnect()
        this._forward('modbus:status', { state: 'disconnected' })
      },
      'modbus:startPoll': config => this.poller.start(config),
      'modbus:stopPoll': () => this.poller.stop(),
      'modbus:write': ({ area, addr, words }) => this.poller.running
        ? this.poller.write(area, addr, words)
        : this.service.write(area, addr, words),
      'modbus:rawRequest': request => this.service.rawRequest(request),
      'config:load': () => this.configStore.load(),
      'config:save': config => this.configStore.save(config),
      'device:start': ({ id, cfg }) => this.deviceManager.start(id, cfg),
      'device:stop': id => this.deviceManager.stop(id),
      'device:write': ({ id, area, addr, words }) =>
        this.deviceManager.write(id, area, addr, words),
      'device:rawFrame': ({ id, frameBytes, timeoutMs }) =>
        this.deviceManager.rawFrame(id, frameBytes, timeoutMs),
      // 与 Electron 端信封一致：成功包 ok:true（Electron 对话框取消时另有 ok:false/canceled）
      'llm:extractText': async params => ({ ok: true, ...(await this.llmService.extractText(params)) }),
      'llm:extractPoints': params => this.llmService.extractPoints(params),
      'llm:testConnection': params => this.llmService.testConnection(params),
      'llm:getQuota': () => this.llmService.getQuota(),
    })

    this._registerSourceListeners()
  }

  invoke(channel, ...args) {
    if (this._closing) return Promise.reject(new Error('Web 运行时已关闭，无法继续调用'))
    const handler = this._handlers[channel]
    if (!handler) return Promise.reject(new Error(`不支持的运行时通道：${channel}`))

    try {
      return Promise.resolve(handler(...args))
    } catch (error) {
      return Promise.reject(error)
    }
  }

  _register(source, event, listener) {
    source.on(event, listener)
    this._sourceListeners.push({ source, event, listener })
  }

  _registerSourceListeners() {
    // 读取失败日志节流：间歇性掉线时每周期都报"读取失败"会刷屏，
    // 改为一段失败只报第一条，恢复出数据时报一条"已恢复"，大幅降低噪音。
    const errLogged = { poller: false }        // 工作台单连接
    const devErrLogged = new Set()             // 设备实例：记录处于失败态的 id

    this._register(this.poller, 'data', payload => {
      if (errLogged.poller) { errLogged.poller = false; this._forward('modbus:log', { level: 'info', message: '读取已恢复' }) }
      this._forward('modbus:data', payload)
    })
    this._register(this.poller, 'pollError', message => {
      if (errLogged.poller) return  // 同一段失败只报一次
      errLogged.poller = true
      this._forward('modbus:log', { level: 'error', message: `读取失败：${message}` })
    })
    this._register(this.poller, 'offline', () => this._forward('modbus:status', { state: 'offline' }))
    this._register(this.poller, 'online', () => this._forward('modbus:status', { state: 'connected' }))
    this._register(this.deviceManager, 'data', payload => {
      if (devErrLogged.has(payload.id)) { devErrLogged.delete(payload.id); this._forward('device:log', { level: 'info', id: payload.id, message: '读取已恢复' }) }
      this._forward('device:data', payload)
    })
    this._register(this.deviceManager, 'status', payload => this._forward('device:status', payload))
    this._register(this.deviceManager, 'pollError', error => {
      if (devErrLogged.has(error.id)) return  // 同一段失败只报一次
      devErrLogged.add(error.id)
      this._forward('device:log', { level: 'error', id: error.id, message: `读取失败：${error.message}` })
    })
    this._register(this.llmService, 'progress', payload => this._forward('llm:progress', payload))
  }

  _forward(channel, payload) {
    if (!this._closing) this.emit('event', { channel, payload })
  }

  _removeSourceListeners() {
    for (const { source, event, listener } of this._sourceListeners) {
      source.removeListener(event, listener)
    }
    this._sourceListeners.length = 0
  }

  close() {
    if (this._closePromise) return this._closePromise

    this._closing = true
    this._removeSourceListeners()
    this._closePromise = this._closeAll()
    return this._closePromise
  }

  async _closeAll() {
    const errors = []
    const steps = [
      () => this.poller.stop(),
      () => this.deviceManager.stopAll(),
      () => this.service.disconnect(),
    ]

    for (const step of steps) {
      try { await step() } catch (error) { errors.push(error) }
    }

    if (errors.length) {
      throw new AggregateError(errors, `Web 运行时关闭失败，共 ${errors.length} 个清理步骤异常`)
    }
  }
}

function createWebRuntime(options = {}) {
  const service = options.service ?? new ModbusService(options.transportFactory)
  const poller = options.poller ?? new Poller(service)
  const deviceManager = options.deviceManager ?? new DeviceManager(options.createService)
  const configStore = options.configStore ?? createConfigStore(
    options.configFilePath ?? path.join(process.cwd(), 'config.json'),
  )
  const llmService = options.llmService ?? createLlmService({
    loadConfig: () => configStore.load(),
    usageFile: options.llmUsageFile,
  })

  return new WebRuntime({
    service,
    poller,
    deviceManager,
    configStore,
    listSerialPorts: options.listSerialPorts ?? defaultListSerialPorts,
    llmService,
  })
}

module.exports = { createWebRuntime, WEB_RUNTIME_CHANNELS }
