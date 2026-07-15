// Modbus RTU 串口连接实现
const { ModbusTransport } = require('./modbus-transport')

class RtuTransport extends ModbusTransport {
  async open(client, { serialPath, baudRate, dataBits, stopBits, parity }) {
    await client.connectRTUBuffered(serialPath, {
      baudRate,
      dataBits,
      stopBits,
      parity,
    })
  }
}

module.exports = RtuTransport
