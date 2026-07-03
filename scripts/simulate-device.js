// scripts/simulate-device.js — 多功能模拟从站，用于设备调试
// 用法:
//   node scripts/simulate-device.js                 → 8502，电池柜 profile
//   node scripts/simulate-device.js 8503             → 8503，电池柜 profile
//   node scripts/simulate-device.js 8504 plc         → 8504，PLC profile
//   node scripts/simulate-device.js 8505 temp        → 8505，温控器 profile
//   node scripts/simulate-device.js 8502 battery 2   → 8502，电池柜，从站ID 2
// API: const sim = require('./scripts/simulate-device')
//       sim.createSimulator({ port: 8502, profile: 'battery', unitId: 1 })

const ModbusRTU = require('modbus-serial')

// ── profile 定义 ──
// 每个 profile 定义寄存器布局和动态更新逻辑
const PROFILES = {

  // === 电池柜（Battery Cabinet） ===
  battery: {
    name: '电池柜',
    desc: '保持寄存器: 0=电压(V)U16×0.1, 2=电流(A)U16×0.01, 7=温度(℃)F32 AB, 10=心跳, 12=SOC(%)U16',
    holdingSize: 100,
    init(holding, coils) {
      holding[0] = 370       // 37.0V
      holding[1] = 0
      holding[2] = 1200      // 12.00A
      holding[3] = 0
      const f = new DataView(new ArrayBuffer(4))
      f.setFloat32(0, 28.5)  // 28.5℃
      holding[7] = f.getUint16(0)
      holding[8] = f.getUint16(2)
      holding[10] = 0        // 心跳
      holding[12] = 820      // 82.0%
      coils[0] = 1           // 运行中
    },
    tick(holding, coils, elapsed) {
      // 电压缓慢下降（模拟放电）
      const v = 370 - Math.sin(elapsed / 30) * 20 + (Math.random() - 0.5) * 4
      holding[0] = Math.round(Math.max(300, Math.min(420, v)))
      // 电流随机波动
      const a = 1200 + (Math.random() - 0.5) * 200
      holding[2] = Math.round(Math.max(0, Math.min(2000, a)))
      // 温度缓慢变化
      const t = 28.5 + Math.sin(elapsed / 60) * 3 + (Math.random() - 0.5) * 1
      const f = new DataView(new ArrayBuffer(4))
      f.setFloat32(0, Math.round(t * 10) / 10)
      holding[7] = f.getUint16(0)
      holding[8] = f.getUint16(2)
      // 心跳每秒 +1
      holding[10] = (holding[10] + 1) & 0xFFFF
      // SOC 随电压变化
      const soc = 820 - Math.sin(elapsed / 30) * 50 + (Math.random() - 0.5) * 10
      holding[12] = Math.round(Math.max(0, Math.min(1000, soc)))
      // 线圈：电压低于 320 时告警
      coils[1] = holding[0] < 320 ? 1 : 0
    },
    describe(holding) {
      return [
        `电压 ${(holding[0] * 0.1).toFixed(1)}V`,
        `电流 ${(holding[2] * 0.01).toFixed(2)}A`,
        `温度 ${CodecHelper.readFloat32AB(holding, 7).toFixed(1)}℃`,
        `心跳 ${holding[10]}`,
        `SOC ${(holding[12] * 0.1).toFixed(1)}%`,
        `运行 ${holding[0] >= 320 ? '正常' : '低压告警'}`,
      ].join('  |  ')
    },
  },

  // === PLC 控制器 ===
  plc: {
    name: 'PLC 控制器',
    desc: '保持寄存器: 0=产线速度U16, 1=良品数U32, 5=温度F32 BA, 10=运行时长U16(min)',
    holdingSize: 100,
    coilsSize: 50,
    init(holding, coils) {
      holding[0] = 120       // 120 rpm
      holding[1] = 0x0000    // 良品数高16位
      holding[2] = 0x1388    // 良品数低16位 = 5000
      const f = new DataView(new ArrayBuffer(4))
      f.setFloat32(0, 45.8)  // 45.8℃
      holding[5] = f.getUint16(2)  // BA 字序
      holding[6] = f.getUint16(0)
      holding[10] = 128      // 128 min
      coils[0] = 1           // 运行中
      coils[1] = 1           // 自动模式
      coils[3] = 0           // 告警
    },
    tick(holding, coils, elapsed) {
      // 速度随机波动
      holding[0] = Math.round(120 + (Math.random() - 0.5) * 30)
      // 良品数递增
      const hi = holding[1], lo = holding[2]
      let count = (hi << 16) | (lo & 0xFFFF)
      count += Math.floor(Math.random() * 3)
      if (count > 0x7FFFFFFF) count = 5000
      holding[1] = (count >> 16) & 0xFFFF
      holding[2] = count & 0xFFFF
      // 温度
      const t = 45.8 + Math.sin(elapsed / 40) * 5 + (Math.random() - 0.5) * 2
      const f = new DataView(new ArrayBuffer(4))
      f.setFloat32(0, Math.round(t * 10) / 10)
      holding[5] = f.getUint16(2)
      holding[6] = f.getUint16(0)
      // 运行时长递增
      if (elapsed % 60 === 0) holding[10] = Math.min(holding[10] + 1, 999)
    },
    describe(holding) {
      const count = (holding[1] << 16) | holding[2]
      return [
        `速度 ${holding[0]} rpm`,
        `良品 ${count}`,
        `温度 ${CodecHelper.readFloat32BA(holding, 5).toFixed(1)}℃`,
        `运行 ${holding[10]} min`,
      ].join('  |  ')
    },
  },

  // === 温控器 ===
  temp: {
    name: '温控器',
    desc: '保持寄存器: 0=温度F32 AB, 2=湿度F32 AB, 4=目标温度U16(℃×10), 10=状态; 线圈: 0=加热, 1=制冷',
    holdingSize: 80,
    init(holding, coils) {
      const f1 = new DataView(new ArrayBuffer(4))
      f1.setFloat32(0, 22.5)
      holding[0] = f1.getUint16(0)
      holding[1] = f1.getUint16(2)
      const f2 = new DataView(new ArrayBuffer(4))
      f2.setFloat32(0, 55.0)
      holding[2] = f2.getUint16(0)
      holding[3] = f2.getUint16(2)
      holding[4] = 250      // 25.0℃
      holding[10] = 1        // 正常运行
      coils[0] = 0           // 停止加热
      coils[1] = 0
    },
    tick(holding, coils, elapsed) {
      const current = CodecHelper.readFloat32AB(holding, 0)
      const target = holding[4] / 10
      // 趋近目标温度
      const delta = (target - current) * 0.05 + (Math.random() - 0.5) * 0.3
      const next = current + delta
      const f = new DataView(new ArrayBuffer(4))
      f.setFloat32(0, Math.round(next * 10) / 10)
      holding[0] = f.getUint16(0)
      holding[1] = f.getUint16(2)
      // 湿度随机波动
      const h = 55 + Math.sin(elapsed / 45) * 8 + (Math.random() - 0.5) * 2
      const f2 = new DataView(new ArrayBuffer(4))
      f2.setFloat32(0, Math.round(h * 10) / 10)
      holding[2] = f2.getUint16(0)
      holding[3] = f2.getUint16(2)
      // 加热/制冷状态
      coils[0] = next < target - 0.5 ? 1 : 0
      coils[1] = next > target + 0.5 ? 1 : 0
    },
    describe(holding) {
      return [
        `温度 ${CodecHelper.readFloat32AB(holding, 0).toFixed(1)}℃`,
        `湿度 ${CodecHelper.readFloat32AB(holding, 2).toFixed(1)}%`,
        `目标 ${(holding[4] / 10).toFixed(1)}℃`,
      ].join('  |  ')
    },
  },
}

// ── 编码辅助（避免依赖 renderer/codec.js） ──
const CodecHelper = {
  readFloat32AB(buf, idx) {
    const f = new DataView(new ArrayBuffer(4))
    f.setUint16(0, buf[idx] || 0), f.setUint16(2, buf[idx + 1] || 0)
    return f.getFloat32(0)
  },
  readFloat32BA(buf, idx) {
    const f = new DataView(new ArrayBuffer(4))
    f.setUint16(0, buf[idx + 1] || 0), f.setUint16(2, buf[idx] || 0)
    return f.getFloat32(0)
  },
}

// ── 创建模拟器 ──
function createSimulator({ port = 8502, profile = 'battery', unitId = 1 } = {}) {
  const prof = PROFILES[profile]
  if (!prof) throw new Error(`未知 profile: ${profile}，可选: ${Object.keys(PROFILES).join(', ')}`)

  const holding = new Uint16Array(prof.holdingSize || 200)
  const coils = new Uint8Array(prof.coilsSize || 200)
  const inputReg = new Uint16Array(200)
  const discrete = new Uint8Array(200)

  // 预置输入寄存器（只读）
  for (let i = 0; i < 200; i++) inputReg[i] = 4000 + i

  // 调用 profile 初始化
  prof.init(holding, coils)

  let tickCount = 0
  const timer = setInterval(() => {
    prof.tick(holding, coils, tickCount)
    tickCount++
  }, 1000)

  const vector = {
    getHoldingRegister: addr => holding[addr] || 0,
    getInputRegister:   addr => inputReg[addr] || 0,
    getCoil:            addr => coils[addr] === 1,
    getDiscreteInput:   addr => discrete[addr] === 1,
    setRegister: (addr, value) => { holding[addr] = value },
    setCoil:     (addr, value) => { coils[addr] = value ? 1 : 0 },
  }

  const server = new ModbusRTU.ServerTCP(vector, { host: '0.0.0.0', port, unitID: unitId })

  // 终端状态显示
  const statusInterval = setInterval(() => {
    try { prof.describe(holding) } catch (_) {} // 静默
  }, 2000)

  const url = `127.0.0.1:${port} (从站ID ${unitId})`

  console.log(`╔══════════════════════════════════════════════════╗`)
  console.log(`║  🔧 模拟从站已启动`)
  console.log(`║  ─────────────────────────────`)
  console.log(`║  Profile:  ${prof.name}`)
  console.log(`║  地址:     ${url}`)
  console.log(`║  说明:     ${prof.desc}`)
  console.log(`║  ─────────────────────────────`)
  console.log(`║  数据预览: ${prof.describe(holding)}`)
  console.log(`╚══════════════════════════════════════════════════╝`)
  console.log(`[模拟器] 状态每 2s 刷新，Ctrl+C 停止`)

  setInterval(() => {
    console.log(`[${new Date().toLocaleTimeString()}] [${prof.name}@${url}] ${prof.describe(holding)}`)
  }, 2000)

  return {
    server, holding, coils, inputReg, discrete,
    profile: prof,
    close: () => {
      clearInterval(timer)
      clearInterval(statusInterval)
      return new Promise(r => server.close(r))
    },
  }
}

module.exports = { createSimulator, PROFILES }

// ── 独立运行 ──
if (require.main === module) {
  const port = Number(process.argv[2]) || 8502
  const profile = process.argv[3] || 'battery'
  const unitId = Number(process.argv[4]) || 1

  if (!PROFILES[profile]) {
    console.error(`❌ 未知 profile: "${profile}"`)
    console.error(`   可用: ${Object.keys(PROFILES).join(', ')}`)
    process.exit(1)
  }

  createSimulator({ port, profile, unitId })
}
