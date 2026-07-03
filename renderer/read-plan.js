// renderer/read-plan.js — 设备点位 → 批量读取块规划（纯函数，无依赖）
// 浏览器：<script> 引入后使用全局 ReadPlan；Vitest：module.exports 加载
const ReadPlan = (() => {
  const MAX_BLOCK = 120   // 单块寄存器上限（Modbus 单次 125，留余量）

  // points: [{ area, addr, words }] → [{ area, addr, count }]（按区域合并连续块，超限拆块）
  function buildReadPlan(points) {
    const byArea = {}
    for (const p of points) (byArea[p.area] = byArea[p.area] || []).push(p)
    const blocks = []
    for (const area of Object.keys(byArea)) {
      const sorted = [...byArea[area]].sort((a, b) => a.addr - b.addr)
      let start = null, end = null
      for (const p of sorted) {
        const pEnd = p.addr + (p.words || 1) - 1
        if (start === null) { start = p.addr; end = pEnd; continue }
        if (pEnd - start + 1 <= MAX_BLOCK) { end = Math.max(end, pEnd) }
        else { blocks.push({ area, addr: start, count: end - start + 1 }); start = p.addr; end = pEnd }
      }
      if (start !== null) blocks.push({ area, addr: start, count: end - start + 1 })
    }
    return blocks
  }

  // 从读取结果块（含 values）中取出某点位的寄存器切片；未命中返回 null
  function pickValues(blocks, point) {
    const words = point.words || 1
    for (const b of blocks) {
      if (b.area !== point.area) continue
      const off = point.addr - b.addr
      if (off >= 0 && off + words <= b.values.length) return b.values.slice(off, off + words)
    }
    return null
  }

  return { buildReadPlan, pickValues }
})()

if (typeof module !== 'undefined' && module.exports) module.exports = ReadPlan
