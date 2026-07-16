// renderer/device-config.js — 设备实例连接配置与运行配置纯函数
const DeviceConfig = (() => {
  const connectionUI = typeof module !== 'undefined' && module.exports
    ? require('./connection-ui.js')
    : ConnectionUI
  const VALID_INTERVALS = new Set([100, 500, 1000, 2000, 5000, 10000, 15000])
  const TWO_WORD_TYPES = new Set(['int32', 'uint32', 'float32'])
  const MANAGED_INSTANCE_KEYS = new Set([
    'id', 'typeId', 'name', 'iconIdx', 'interval',
    'transport', 'host', 'port', 'serialPath', 'baudRate', 'dataBits', 'parity', 'stopBits',
    'unitId', 'timeout',
  ])
  const UNSAFE_METADATA_KEYS = new Set(['__proto__', 'prototype', 'constructor', 'pollution'])
  const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/

  function safeShallowCopy(value) {
    const result = {}
    if (!value || typeof value !== 'object' || Array.isArray(value)) return result
    for (const key of Object.keys(value)) {
      if (!UNSAFE_METADATA_KEYS.has(key)) result[key] = value[key]
    }
    return result
  }

  function normalizeInstanceView(instance = {}) {
    return connectionUI.normalizeConnectionView(instance)
  }

  function normalizeInterval(value) {
    const interval = Number(value)
    if (!Number.isInteger(interval) || !VALID_INTERVALS.has(interval)) throw new Error('周期值无效')
    return interval
  }

  function buildInstanceRecord(existing = {}, values = {}) {
    const typeId = typeof values.typeId === 'string' ? values.typeId.trim() : ''
    const name = typeof values.name === 'string' ? values.name.trim() : ''
    if (!typeId) throw new Error('请选择设备类型')
    if (!name) throw new Error('请输入实例名称')
    const connection = connectionUI.buildConnectionConfig(values)
    const metadata = {}
    for (const key of Object.keys(existing)) {
      if (MANAGED_INSTANCE_KEYS.has(key) || UNSAFE_METADATA_KEYS.has(key)) continue
      metadata[key] = existing[key]
    }
    return {
      ...metadata,
      id: existing.id,
      typeId,
      name,
      iconIdx: Number.isInteger(Number(values.iconIdx)) ? Number(values.iconIdx) : 0,
      interval: normalizeInterval(values.interval),
      ...connection,
    }
  }

  function buildDeviceConfig(instance, type, buildReadPlan) {
    if (!type || !Array.isArray(type.points)) return null
    if (typeof buildReadPlan !== 'function') throw new Error('读取计划构建器不可用')
    const connection = connectionUI.buildConnectionConfig(instance)
    const points = type.points.map(point => ({
      area: point.area,
      addr: point.addr,
      words: point.area === 'coil' || point.area === 'discrete'
        ? 1
        : TWO_WORD_TYPES.has(point.type) ? 2 : 1,
    }))
    return {
      ...connection,
      interval: normalizeInterval(instance.interval),
      // 块间隔与单块上限：受设备帧长度/最小轮询间隔约束时可在实例上配置，透传给采集层
      ...(instance.blockGap != null ? { blockGap: instance.blockGap } : {}),
      // 厂商自定义异常码字典：随连接下发给传输层，把 0x0C 等非标准码翻译成该设备专属提示
      ...(type.exceptionHints ? { exceptionHints: type.exceptionHints } : {}),
      blocks: buildReadPlan(points, instance.maxBlock, instance.maxGap),
    }
  }

  function assertInstanceEditable(running) {
    if (running) throw new Error('设备正在运行，请先停止设备再编辑连接参数')
  }

  function isMissingDeviceError(error) {
    const message = String(error?.message || error)
    return /设备.*(?:未连接|不存在|未找到)|(?:device\s+)?not\s+(?:found|connected)/i.test(message)
  }

  async function deleteInstanceSafely(id, deviceStop, remove, markStopped) {
    if (typeof deviceStop !== 'function' || typeof remove !== 'function') throw new Error('删除设备实例的处理器配置错误')
    try {
      await deviceStop(id)
    } catch (error) {
      if (!isMissingDeviceError(error)) throw error
    }
    if (typeof markStopped === 'function') markStopped()
    try {
      await remove()
    } catch (error) {
      if (error && (typeof error === 'object' || typeof error === 'function')) error.deviceStoppedBeforeDelete = true
      throw error
    }
  }

  async function commitInstanceList(nextInstances, persist, apply) {
    if (!Array.isArray(nextInstances) || typeof persist !== 'function' || typeof apply !== 'function') {
      throw new Error('实例列表事务配置错误')
    }
    await persist(nextInstances)
    apply(nextInstances)
  }

  function createExclusiveAction(onPending = () => {}) {
    let pending = null
    return {
      run(action) {
        if (pending) return pending
        if (typeof action !== 'function') return Promise.reject(new Error('独占操作必须是函数'))
        onPending(true)
        let operation
        try { operation = Promise.resolve(action()) } catch (error) { operation = Promise.reject(error) }
        const tracked = operation.finally(() => {
          if (pending === tracked) {
            pending = null
            onPending(false)
          }
        })
        pending = tracked
        return tracked
      },
      isPending() { return pending !== null },
    }
  }

  function createKeyedExclusiveRunner() {
    const pending = new Map()
    return {
      run(key, action) {
        if (pending.has(key)) return pending.get(key)
        if (typeof action !== 'function') return Promise.reject(new Error('独占操作必须是函数'))
        let operation
        try { operation = Promise.resolve(action()) } catch (error) { operation = Promise.reject(error) }
        const tracked = operation.finally(() => {
          if (pending.get(key) === tracked) pending.delete(key)
        })
        pending.set(key, tracked)
        return tracked
      },
      isPending(key) { return pending.has(key) },
    }
  }

  function normalizeLoadedDevices(config = {}) {
    const warnings = []
    const types = []
    for (const raw of Array.isArray(config.deviceTypes) ? config.deviceTypes : []) {
      if (!raw || typeof raw !== 'object' || !SAFE_ID.test(raw.id || '')) {
        warnings.push('设备类型标识符非法，已跳过')
        continue
      }
      const type = safeShallowCopy(raw)
      type.points = Array.isArray(raw.points) ? raw.points : []
      types.push(type)
    }

    const instances = []
    for (const raw of Array.isArray(config.deviceInstances) ? config.deviceInstances : []) {
      if (!raw || typeof raw !== 'object' || !SAFE_ID.test(raw.id || '') || !SAFE_ID.test(raw.typeId || '')) {
        warnings.push('设备实例标识符非法，已跳过')
        continue
      }
      const instance = safeShallowCopy(raw)
      if (!VALID_INTERVALS.has(Number(instance.interval))) {
        instance.interval = 1000
        warnings.push(`设备实例 ${instance.id} 的采集周期非法，已重置为 1000ms`)
      } else {
        instance.interval = Number(instance.interval)
      }
      instances.push(instance)
    }
    return { types, instances, warnings }
  }

  const FOCUSABLE_SELECTOR = 'a[href], button, input, select, textarea, [tabindex]'
  const HIDDEN_GROUP_SELECTOR = '.hidden, [aria-hidden="true"]'

  function getFocusable(container) {
    if (!container || typeof container.querySelectorAll !== 'function') return []
    return [...container.querySelectorAll(FOCUSABLE_SELECTOR)].filter(el =>
      !el.disabled && !el.hidden && el.tabIndex >= 0 && !el.closest(HIDDEN_GROUP_SELECTOR),
    )
  }

  function createDialogKeyController({ getControls, getActive, onEscape }) {
    return {
      handle(event) {
        if (event.key === 'Escape') { onEscape(); return }
        if (event.key !== 'Tab') return
        const controls = getControls()
        if (!controls.length) return
        const active = getActive()
        const first = controls[0]
        const last = controls[controls.length - 1]
        if (!event.shiftKey && active === last) {
          event.preventDefault()
          first.focus()
        } else if (event.shiftKey && active === first) {
          event.preventDefault()
          last.focus()
        }
      },
    }
  }

  function applyRadioSelection(options, selectedIndex) {
    options.forEach((option, index) => {
      const selected = index === selectedIndex
      option.classList.toggle('active', selected)
      option.setAttribute('aria-checked', String(selected))
      option.tabIndex = selected ? 0 : -1
    })
  }

  function createSessionGuard() {
    let generation = 0
    return {
      begin() { generation += 1; return generation },
      invalidate() { generation += 1 },
      isCurrent(token) { return token === generation },
    }
  }

  return {
    applyRadioSelection,
    assertInstanceEditable,
    buildDeviceConfig,
    buildInstanceRecord,
    commitInstanceList,
    createDialogKeyController,
    createExclusiveAction,
    createKeyedExclusiveRunner,
    createSessionGuard,
    deleteInstanceSafely,
    getFocusable,
    normalizeLoadedDevices,
    normalizeInstanceView,
  }
})()

if (typeof window !== 'undefined') window.DeviceConfig = DeviceConfig
if (typeof module !== 'undefined' && module.exports) module.exports = DeviceConfig
