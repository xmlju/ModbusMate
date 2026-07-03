// test/simulator.js — Modbus-TCP 从站模拟器
// 独立运行：node test/simulator.js [端口]（默认 8502，从站ID 1）
// 集成测试：const { createSimulator } = require('./simulator')
const ModbusRTU = require('modbus-serial')

function createSimulator(port = 8502) {
  const holding = new Uint16Array(200)
  const coils = new Uint8Array(200)

  // 预置数据：40001=250；40003/40004 = Float32(AB) 25.6
  holding[0] = 250
  const f = new DataView(new ArrayBuffer(4))
  f.setFloat32(0, 25.6)
  holding[2] = f.getUint16(0)
  holding[3] = f.getUint16(2)

  // 地址 10 每秒自增，模拟变化的传感器值（供界面观察高亮）
  const timer = setInterval(() => { holding[10] = (holding[10] + 1) & 0xFFFF }, 1000)

  const vector = {
    getHoldingRegister: addr => holding[addr],
    getInputRegister:   addr => 1000 + addr,
    getCoil:            addr => coils[addr] === 1,
    getDiscreteInput:   addr => addr % 2 === 0,
    setRegister: (addr, value) => { holding[addr] = value },
    setCoil:     (addr, value) => { coils[addr] = value ? 1 : 0 },
  }

  const server = new ModbusRTU.ServerTCP(vector, { host: '0.0.0.0', port, unitID: 1 })
  return {
    server, holding, coils,
    close: () => { clearInterval(timer); return new Promise(r => server.close(r)) },
  }
}

module.exports = { createSimulator }

if (require.main === module) {
  const port = Number(process.argv[2]) || 8502
  createSimulator(port)
  console.log(`Modbus-TCP 模拟从站已启动: 127.0.0.1:${port}（从站ID 1）`)
  console.log('预置: 40001=250, 40003/40004=Float32(AB) 25.6, 40011 每秒自增')
}
