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
      blocks: buildReadPlan(points),
    }
  }

  function assertInstanceEditable(running) {
    if (running) throw new Error('设备正在运行，请先停止设备再编辑连接参数')
  }

  function isMissingDeviceError(error) {
    const message = String(error?.message || error)
    return /设备.*(?:未连接|不存在|未找到)|(?:device\s+)?not\s+(?:found|connected)/i.test(message)
  }

  async function deleteInstanceSafely(id, deviceStop, remove) {
    if (typeof deviceStop !== 'function' || typeof remove !== 'function') throw new Error('删除设备实例的处理器配置错误')
    try {
      await deviceStop(id)
    } catch (error) {
      if (!isMissingDeviceError(error)) throw error
    }
    await remove()
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
    assertInstanceEditable,
    buildDeviceConfig,
    buildInstanceRecord,
    createSessionGuard,
    deleteInstanceSafely,
    normalizeInstanceView,
  }
})()

if (typeof window !== 'undefined') window.DeviceConfig = DeviceConfig
if (typeof module !== 'undefined' && module.exports) module.exports = DeviceConfig
