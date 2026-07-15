// 根据连接配置创建对应的 Modbus 传输实例
const TcpTransport = require('./tcp-transport')
const RtuTransport = require('./rtu-transport')

function createTransport(config = {}, createClient) {
  const prototype = config !== null && typeof config === 'object'
    ? Object.getPrototypeOf(config)
    : undefined
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('连接配置必须是对象')
  }

  if (config.transport === 'rtu') {
    return new RtuTransport(createClient)
  }
  if (config.transport === undefined || config.transport === 'tcp') {
    return new TcpTransport(createClient)
  }
  throw new Error(`未知通信方式: ${config.transport}`)
}

module.exports = { createTransport }
