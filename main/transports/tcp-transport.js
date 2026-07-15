// Modbus TCP 连接实现
const { ModbusTransport } = require('./modbus-transport')

class TcpTransport extends ModbusTransport {
  async open(client, { host, port }) {
    await client.connectTCP(host, { port })
  }
}

module.exports = TcpTransport
