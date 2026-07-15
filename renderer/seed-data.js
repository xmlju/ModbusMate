// renderer/seed-data.js — 示例数据种子（首次启动空配置时自动填充）
// 依赖 window.api；在 app.js 加载
const SeedData = (() => {

  // ── 示例设备类型定义 ──
  const sampleTypes = [
    {
      id: 'sample_battery',
      name: '电池柜',
      points: [
        { name: '电池电压', area: 'holding', addr: 0, type: 'uint16', wordOrder: 'AB', k: 0.1, b: 0, decimals: 1, unit: 'V' },
        { name: '电池电流', area: 'holding', addr: 2, type: 'uint16', wordOrder: 'AB', k: 0.01, b: 0, decimals: 2, unit: 'A' },
        { name: '温度', area: 'holding', addr: 7, type: 'float32', wordOrder: 'AB', k: 1, b: 0, decimals: 1, unit: '℃' },
        { name: '心跳', area: 'holding', addr: 10, type: 'uint16', wordOrder: 'AB', k: 1, b: 0, decimals: 0, unit: '' },
        { name: 'SOC', area: 'holding', addr: 12, type: 'uint16', wordOrder: 'AB', k: 0.1, b: 0, decimals: 1, unit: '%' },
      ],
    },
    {
      id: 'sample_plc',
      name: 'PLC 控制器',
      points: [
        { name: '产线速度', area: 'holding', addr: 0, type: 'uint16', wordOrder: 'AB', k: 1, b: 0, decimals: 0, unit: 'rpm' },
        { name: '良品数', area: 'holding', addr: 1, type: 'uint32', wordOrder: 'AB', k: 1, b: 0, decimals: 0, unit: '' },
        { name: '温度', area: 'holding', addr: 5, type: 'float32', wordOrder: 'BA', k: 1, b: 0, decimals: 1, unit: '℃' },
        { name: '运行时长', area: 'holding', addr: 10, type: 'uint16', wordOrder: 'AB', k: 1, b: 0, decimals: 0, unit: 'min' },
      ],
    },
  ]

  // ── 示例设备实例（指向内置模拟器地址） ──
  let nextSampleId = 100
  function sampleId() { return `dev${nextSampleId++}` }

  const sampleInstances = [
    { id: sampleId(), typeId: 'sample_battery', name: '1号电池柜', host: '127.0.0.1', port: 8502, unitId: 1, interval: 1000 },
    { id: sampleId(), typeId: 'sample_plc', name: 'PLC-1', host: '127.0.0.1', port: 8503, unitId: 1, interval: 1000 },
  ]

  // ── 示例数据只在首次启动（从未填充过）时写入一次；用户之后删除不会被复活 ──
  async function ensureSeedData() {
    try {
      const cfg = await window.api.loadConfig()
      if (cfg.seedDataInitialized) return null

      if (!Array.isArray(cfg.deviceTypes)) cfg.deviceTypes = []
      sampleTypes.forEach(st => {
        if (!cfg.deviceTypes.find(t => t.id === st.id)) cfg.deviceTypes.push(st)
      })

      if (!Array.isArray(cfg.deviceInstances)) cfg.deviceInstances = []
      sampleInstances.forEach(si => {
        if (!cfg.deviceInstances.find(i => i.id === si.id)) cfg.deviceInstances.push(si)
      })

      cfg.seedDataInitialized = true
      await window.api.saveConfig(cfg)
      console.log('[SeedData] 首次启动，已写入示例数据：电池柜 + PLC 控制器')
      return { deviceTypes: sampleTypes, deviceInstances: sampleInstances }
    } catch (e) {
      console.error('[SeedData] 种子数据填充失败:', e)
    }
    return null
  }

  return { ensureSeedData, sampleTypes, sampleInstances }
})()

if (typeof module !== 'undefined' && module.exports) module.exports = SeedData
