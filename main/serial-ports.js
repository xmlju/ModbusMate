// main/serial-ports.js — 跨平台串口枚举与稳定字段归一化
const { SerialPort } = require('serialport')

async function listSerialPorts(list = () => SerialPort.list()) {
  try {
    const ports = await list()

    return ports
      .filter(port => typeof port?.path === 'string' && port.path.trim() !== '')
      .map(port => {
        const manufacturer = port.manufacturer ?? ''
        return {
          path: port.path,
          displayName: manufacturer ? `${port.path} · ${manufacturer}` : port.path,
          manufacturer,
          serialNumber: port.serialNumber ?? '',
          vendorId: port.vendorId ?? '',
          productId: port.productId ?? '',
        }
      })
      .sort((left, right) => left.path.localeCompare(right.path))
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    const error = new Error(`串口枚举失败：${message}`, { cause })
    if (cause?.code !== undefined) error.code = cause.code
    throw error
  }
}

module.exports = { listSerialPorts }
