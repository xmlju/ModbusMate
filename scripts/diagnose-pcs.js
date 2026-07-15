// 一次性诊断脚本：依次读取 6 个电池包的 PCS/DCDC 寄存器块，报告每个包成功/失败详情
// 用法：node scripts/diagnose-pcs.js [串口路径]
const ModbusService = require('../main/modbus-service')

const serialPath = process.argv[2] || '/dev/tty.usbserial-1110'

const PACK_COUNT = 6
const BASE = 10190
const STRIDE = 300
const COUNT = 42

async function main() {
  const service = new ModbusService()
  console.log(`连接 RTU：${serialPath}，9600 8N1，从站 1 ...`)
  await service.connect({
    transport: 'rtu', serialPath, baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1, unitId: 1, timeout: 2000,
  })
  console.log('连接成功\n')

  for (let pack = 1; pack <= PACK_COUNT; pack++) {
    const addr = BASE + (pack - 1) * STRIDE
    const start = Date.now()
    try {
      const values = await service.read('holding', addr, COUNT)
      const elapsed = Date.now() - start
      const nonZero = values.filter(v => v !== 0).length
      console.log(`[电池包${pack}] OK  地址 ${addr}-${addr + COUNT - 1}  耗时 ${elapsed}ms  非零寄存器 ${nonZero}/${COUNT}`)
      console.log(`  前6个寄存器原始值: ${values.slice(0, 6).join(', ')}`)
    } catch (err) {
      const elapsed = Date.now() - start
      console.log(`[电池包${pack}] FAIL 地址 ${addr}-${addr + COUNT - 1}  耗时 ${elapsed}ms`)
      console.log(`  错误: ${err.message}`)
    }
    await new Promise(resolve => setTimeout(resolve, 300))
  }

  await service.disconnect()
  console.log('\n已断开连接')
}

main().catch(err => {
  console.error('诊断脚本异常:', err.message)
  process.exit(1)
})
