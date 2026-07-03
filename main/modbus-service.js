// main/modbus-service.js — Modbus-TCP 连接与读写封装（单连接单设备）
const ModbusRTU = require('modbus-serial')

const AREA_READERS = {
  coil:     { fn: 'readCoils',            isBit: true },
  discrete: { fn: 'readDiscreteInputs',   isBit: true },
  holding:  { fn: 'readHoldingRegisters', isBit: false },
  input:    { fn: 'readInputRegisters',   isBit: false },
}

// Modbus 异常码 → 现场工程师能看懂的中文提示
const EXCEPTION_HINTS = {
  1: '非法功能码：设备不支持该操作',
  2: '非法数据地址：设备不存在该地址，请检查起始地址和数量',
  3: '非法数据值：写入值不被设备接受',
  4: '设备故障：从站执行请求时发生不可恢复错误',
  6: '设备忙：从站正在处理其他命令，请稍后重试',
}

function friendly(err) {
  if (err?.modbusCode) {
    return new Error(`设备返回异常码 ${err.modbusCode}（${EXCEPTION_HINTS[err.modbusCode] || '未知异常'}）`)
  }
  if (/Timed out/i.test(err?.message || '')) return new Error('请求超时：设备无响应，请检查网络和从站ID')
  if (/Port Not Open/i.test(err?.message || '')) return new Error('连接已断开')
  return err
}

class ModbusService {
  constructor() {
    this.client = null
    this.params = null   // 保存最近一次连接参数，供断线重连
  }

  get connected() { return this.client?.isOpen === true }

  async connect({ host, port = 502, unitId = 1, timeout = 2000 }) {
    await this.disconnect()
    const client = new ModbusRTU()
    await client.connectTCP(host, { port })
    client.setID(unitId)
    client.setTimeout(timeout)
    this.client = client
    this.params = { host, port, unitId, timeout }
  }

  async reconnect() {
    if (!this.params) throw new Error('尚未配置过连接参数')
    await this.connect(this.params)
  }

  async disconnect() {
    if (this.client?.isOpen) await new Promise(r => this.client.close(r))
    this.client = null
  }

  // 读取一个区域，统一返回数值数组（位区域为 0/1，寄存器为 0~65535）
  async read(area, addr, count) {
    const reader = AREA_READERS[area]
    if (!reader) throw new Error(`未知区域类型: ${area}`)
    try {
      const res = await this.client[reader.fn](addr, count)
      return reader.isBit ? res.data.slice(0, count).map(b => (b ? 1 : 0)) : Array.from(res.data)
    } catch (err) { throw friendly(err) }
  }

  // 写入：coil → FC05；holding 1 字 → FC06，2 字 → FC16
  async write(area, addr, words) {
    if (area === 'discrete' || area === 'input') throw new Error('该区域为只读，不支持写入')
    try {
      if (area === 'coil') return await this.client.writeCoil(addr, words[0] === 1)
      if (words.length === 1) return await this.client.writeRegister(addr, words[0])
      return await this.client.writeRegisters(addr, words)
    } catch (err) { throw friendly(err) }
  }
}

module.exports = ModbusService
