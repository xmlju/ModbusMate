// renderer/llm-utils.js — LLM 点表向导的纯函数工具集（UMD）
// 浏览器：<script> 引入后使用全局 LlmUtils；Vitest：module.exports 加载
const LlmUtils = (() => {

/** 四大区域 key */
const AREAS = ['holding', 'input', 'coil', 'discrete']

// ═══════════════════════════════════════════════
// 1. 区域分布统计
// ═══════════════════════════════════════════════

/**
 * 统计点位在各个 Modbus 区域的分布，返回含总数的结构。
 * 用于解析结果预览页面展示"holding 80 / input 30 / coil 20 / discrete 0，共 130 点"。
 *
 * @param {Array<{area: string}>} points - 点位数组（只需 area 字段）
 * @returns {{ holding: number, input: number, coil: number, discrete: number, total: number }}
 */
function areaStats(points) {
  const stats = { holding: 0, input: 0, coil: 0, discrete: 0, total: 0 }
  if (!Array.isArray(points)) return stats
  for (const p of points) {
    if (!p || typeof p !== 'object') continue
    const area = p.area
    if (typeof area === 'string' && stats.hasOwnProperty(area)) {
      stats[area] += 1
      stats.total += 1
    }
  }
  return stats
}

// ═══════════════════════════════════════════════
// 2. Token 费用估算
// ═══════════════════════════════════════════════

/**
 * 根据总 token 用量估算费用。
 *
 * @param {number} totalTokens - token 总数
 * @param {number} [pricePerMTokenCNY=4] - 每百万 token 单价（¥），默认 4
 * @returns {{ totalCost: number }} 保留 2 位小数
 */
function estimateCost(totalTokens, pricePerMTokenCNY = 4) {
  const t = Math.max(0, Number(totalTokens) || 0)
  const raw = t / 1000000 * pricePerMTokenCNY
  return {
    totalCost: Math.round(raw * 100) / 100,
  }
}

// ═══════════════════════════════════════════════
// 3. Base64 分块（网页模式大文件 IPC 传输）
// ═══════════════════════════════════════════════

/**
 * 将 base64 字符串按指定大小分块，防止单条 IPC 消息过大。
 * 网页模式中，用户在浏览器选择文件 → renderer 将 buffer 编码为 base64，
 * 再经 preload → IPC → main 进程分批接收后拼接。
 *
 * @param {string} data - base64 编码字符串
 * @param {number} [chunkSize=256*1024] - 每块字符数（默认 256K 字符 ≈ 192KB 原始字节）
 * @returns {{ chunks: string[], totalChunks: number }}
 */
function chunkBase64(data, chunkSize = 256 * 1024) {
  const str = String(data ?? '')
  if (str.length === 0) return { chunks: [], totalChunks: 0 }
  const chunks = []
  for (let i = 0; i < str.length; i += chunkSize) {
    chunks.push(str.slice(i, i + chunkSize))
  }
  return { chunks, totalChunks: chunks.length }
}

// ═══════════════════════════════════════════════
// 4. 类型名默认值生成
// ═══════════════════════════════════════════════

/**
 * 生成新设备类型的默认名称，自动去重递增。
 * 例：第一次调用 → "新建类型_2026-07-17"；已有同名 → "新建类型_2026-07-17 (2)"
 *
 * @param {string[]} existingNames - 已有类型名列表
 * @param {Date|string} [date] - 日期，默认今天
 * @returns {string}
 */
function generateDefaultTypeName(existingNames, date) {
  const d = date ? new Date(date) : new Date()
  const suffix = d.toISOString().slice(0, 10) // YYYY-MM-DD
  const base = `新建类型_${suffix}`
  return deduplicateName(base, existingNames)
}

function deduplicateName(base, existingNames) {
  const set = new Set((existingNames || []).map(n => String(n).trim()))
  if (!set.has(base)) return base
  let i = 2
  while (set.has(`${base} (${i})`)) i++
  return `${base} (${i})`
}

// ═══════════════════════════════════════════════
return { areaStats, estimateCost, chunkBase64, generateDefaultTypeName, AREAS }
})()

if (typeof window !== 'undefined') window.LlmUtils = LlmUtils
if (typeof module !== 'undefined') module.exports = LlmUtils
