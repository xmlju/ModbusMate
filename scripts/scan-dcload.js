// 扫描脚本：尝试不同波特率/停止位/从站地址组合，寻找能与设备通信的参数
// 用法：node scripts/scan-dcload.js [串口路径]
const ModbusService = require('../main/modbus-service')

const serialPath = process.argv[2] || '/dev/tty.usbserial-1110'
const BAUD_RATES = [115200, 57600, 38400, 28800, 9600, 4800, 2400]
const STOP_BITS = [2, 1]
const UNIT_IDS = [1, 2, 3, 4, 5]

async function tryOnce(baudRate, stopBits, unitId) {
  const service = new ModbusService()
  try {
    await service.connect({
      transport: 'rtu', serialPath, baudRate, dataBits: 8, parity: 'none', stopBits, unitId, timeout: 600,
    })
    // 读寄存器 0（模式），只读 1 个寄存器，尽量减少帧长度
    const values = await service.read('holding', 0, 1)
    await service.disconnect()
    return { ok: true, values }
  } catch (err) {
    try { await service.disconnect() } catch {}
    return { ok: false, error: err.message }
  }
}

async function main() {
  console.log(`扫描 ${serialPath}，波特率 x 停止位 x 从站地址 组合...\n`)
  for (const stopBits of STOP_BITS) {
    for (const baudRate of BAUD_RATES) {
      for (const unitId of UNIT_IDS) {
        process.stdout.write(`  ${baudRate} 8N${stopBits} ID${unitId} ... `)
        const result = await tryOnce(baudRate, stopBits, unitId)
        if (result.ok) {
          console.log(`成功! 寄存器0原始值=${result.values[0]}`)
          console.log(`\n找到可用参数：波特率=${baudRate}，停止位=${stopBits}，从站地址=${unitId}`)
          return
        } else {
          console.log(`失败 (${result.error})`)
        }
      }
    }
  }
  console.log('\n全部组合都失败了，可能是接线问题，或从站地址不在 1-5 范围内')
}

main().catch(err => {
  console.error('扫描异常:', err.message)
  process.exit(1)
})
