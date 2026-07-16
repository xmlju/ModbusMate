// main/llm/point-extractor.js — 分段调用 LLM 抽取 Modbus 点位表
// 纯逻辑模块，LLM 调用通过注入的 provider 完成，方便 mock 测试

const path = require('path')

// 从 renderer 加载 Codec（纯函数模块，无浏览器依赖）
const Codec = require(path.join(__dirname, '..', '..', 'renderer', 'codec.js'))
const { validatePoints } = Codec

/** 每段最大字符数 */
const SEGMENT_MAX_CHARS = 12000

/** 段间重叠字符数，防止切断表行 */
const SEGMENT_OVERLAP_CHARS = 500

/** 单段 system prompt（TODO: 明天由 Claude 提供正式版，当前为占位） */
function buildSystemPrompt() {
  return `你是工业 Modbus 通讯规约解析专家。用户提供设备通讯手册的文本片段，你从中抽取寄存器点位表，输出 JSON。

输出格式（严格遵守，不输出任何其他文字）：
{"points":[{"name":"...","area":"holding|input|coil|discrete","addrHex":"手册原文地址","words":1或2,"k":1,"b":0,"decimals":0,"unit":""}]}

抽取规则：
1. 区域词映射：保持寄存器→holding，输入寄存器→input，线圈→coil，离散量/离散输入→discrete。
2. 地址：把手册原文的地址字符串原样放进 addrHex（如 "11C0"、"0000"），不要做进制转换，不要自行判断是 10 进制还是 16 进制——由程序统一处理。
3. 地址区间（如 "0032-0033"）：这是一个双字点位，words=2，addrHex 取起始地址；单地址 words=1。
4. 单位换算："单位：0.001V" → k=0.001，unit="V"，decimals=3；"单位：0.1A" → k=0.1，unit="A"，decimals=1；"单位：ms" → k=1，unit="ms"，decimals=0。没有单位说明则 k=1，unit=""，decimals=0。
5. name 取手册中的点位名称，去掉尾部的取值说明/错误码说明（如 "0x03:数据超出范围"、"OFF:关 ON:开" 不进 name），保留模式前缀（如 "充电桩测试电压需求"）。
6. 只抽取明确带 区域词+地址 的行；描述性段落、目录、标题一律忽略。
7. 同一片段内地址重复的只保留第一条。
8. 线圈/离散量固定 words=1、k=1、decimals=0。`
}

/**
 * 按 ~12K 字符分段，段边界尽量对齐寄存器/地址行，段间重叠 500 字符
 * @param {string} text
 * @returns {string[]}
 */
function segmentText(text) {
  if (!text || text.length <= SEGMENT_MAX_CHARS) {
    return [text]
  }

  const segments = []
  let start = 0

  while (start < text.length) {
    let end = Math.min(start + SEGMENT_MAX_CHARS, text.length)

    // 已到文末：直接推入剩余全部内容并退出，末段不需要重叠
    if (end === text.length) {
      segments.push(text.slice(start, end))
      break
    }

    // 在 [end - SEGMENT_OVERLAP_CHARS, end + SEGMENT_OVERLAP_CHARS] 范围内寻找寄存器/地址行边界
    const searchStart = Math.max(end - SEGMENT_OVERLAP_CHARS, start)
    const chunk = text.slice(searchStart, end + SEGMENT_OVERLAP_CHARS)
    // 匹配区域词 + 地址模式
    const pattern = /(保持寄存器|输入寄存器|线圈|离散量|holding|input|coil|discrete)\s+[0-9a-fA-F]+/gi
    let bestPos = -1
    let match
    while ((match = pattern.exec(chunk)) !== null) {
      const absPos = searchStart + match.index
      if (absPos <= end && absPos > bestPos) {
        bestPos = absPos
      }
    }
    // 修复1: 只在 bestPos 距段首足够远（> start + SEGMENT_OVERLAP_CHARS）时才采纳边界切分，
    // 防止 nextStart 倒退导致死循环
    if (bestPos > start + SEGMENT_OVERLAP_CHARS) {
      end = bestPos
    }

    segments.push(text.slice(start, end))
    // 修复2: 兜底强制前进，保证每轮迭代 start 严格递增
    start = Math.max(end - SEGMENT_OVERLAP_CHARS, start + 1)
    if (start >= text.length) break
  }

  return segments
}

/**
 * 尝试修复截断的 JSON（常见：末尾缺少 }] 等）
 * @param {string} raw - LLM 返回的原始文本
 * @returns {string} 修复后的 JSON 文本
 */
function repairJson(raw) {
  let s = raw.trim()
  // 去掉可能的 markdown 代码块包裹
  const mdMatch = s.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (mdMatch) {
    s = mdMatch[1].trim()
  }
  // 尝试修补末尾缺失的括号
  let depth = 0
  for (const ch of s) {
    if (ch === '{' || ch === '[') depth++
    else if (ch === '}' || ch === ']') depth--
  }
  while (depth > 0) {
    // 检查最后一个非空白字符来决定补 } 还是 ]
    const trimmed = s.trimEnd()
    const last = trimmed[trimmed.length - 1]
    if (last === '{' || last === ',' || last === ':') {
      s += '}'
    } else if (last === '[') {
      s += ']'
    } else if (last === '"' || /[0-9]/.test(last) || last === 'e' || last === 'l') {
      s += '}]'
      depth -= 2
      continue
    } else {
      s += '}'
    }
    depth--
  }
  return s
}

/**
 * 将 LLM 返回的 addrHex 统一转十进制
 * @param {string} addrHex
 * @returns {number}
 */
function addrHexToDecimal(addrHex) {
  return parseInt(String(addrHex).trim(), 16)
}

/**
 * 检查文档中地址是否有可能是十进制而非十六进制
 * 规则：若整份文档地址中无 [a-fA-F] 且存在 8/9 开头三位以上地址，提示用户确认
 * @param {Array<{addrHex: string}>} rawPoints
 * @returns {string|null} 提示信息，无歧义则返回 null
 */
function checkAddrAmbiguity(rawPoints) {
  const hexStrs = rawPoints.map(p => String(p.addrHex || '').trim())
  const hasHexChar = hexStrs.some(s => /[a-fA-F]/.test(s))
  if (hasHexChar) return null
  const hasAmbiguous = hexStrs.some(s => /^[89]\d{2,}$/.test(s))
  if (hasAmbiguous) {
    return '文档地址中未发现 A-F 字符，但存在 8/9 开头的多位地址，请人工确认进制'
  }
  return null
}

/**
 * 将 LLM 原始返回的点位转换为 modbusmate-points@1 格式
 * @param {Array} rawPoints - LLM 返回的原始点位数组
 * @returns {{ points: Array, dropped: number }}
 */
function convertPoints(rawPoints) {
  const seen = new Set()
  const points = []
  let dropped = 0

  for (const raw of rawPoints) {
    if (!raw || typeof raw !== 'object') continue
    const addrHex = String(raw.addrHex || '').trim()
    if (!addrHex) continue
    const area = String(raw.area || '').trim()
    if (!area) continue

    const addr = addrHexToDecimal(addrHex)
    if (isNaN(addr) || addr < 0 || addr > 65535) {
      dropped++
      continue
    }

    const words = raw.words === 2 ? 2 : 1
    const type = words === 2 ? 'uint32' : 'uint16'
    const name = String(raw.name || '').trim()
    if (!name) { dropped++; continue }

    const k = typeof raw.k === 'number' && !isNaN(raw.k) ? raw.k : 1
    const b = typeof raw.b === 'number' && !isNaN(raw.b) ? raw.b : 0
    const decimals = typeof raw.decimals === 'number' && !isNaN(raw.decimals)
      ? raw.decimals : 0
    const unit = String(raw.unit || '').trim()

    const key = `${area}:${addr}`
    if (seen.has(key)) continue
    seen.add(key)

    points.push({
      name,
      area,
      addr,
      type,
      wordOrder: 'AB',
      k,
      b,
      decimals,
      unit,
      visible: true,
    })
  }

  return { points, dropped }
}

/**
 * 核心：从文档文本中抽取点位表
 * @param {object} opts
 * @param {string} opts.text - 文档全文
 * @param {object} opts.provider - { chatCompletion } 接口
 * @param {function} [opts.onProgress] - 进度回调 ({ segment, totalSegments, accumulatedPoints, accumulatedTokens })
 * @returns {Promise<{ points: Array, stats: { totalSegments: number, totalTokens: number, droppedInvalid: number, addrAmbiguityWarning: string|null } }>}
 */
async function extractPoints({ text, provider, onProgress }) {
  if (!text || !provider) {
    throw new Error('缺少必要参数: text 和 provider')
  }

  const segments = segmentText(text)
  const systemPrompt = buildSystemPrompt()
  const allRawPoints = []
  let totalTokens = 0

  for (let i = 0; i < segments.length; i++) {
    const segText = segments[i]
    const userMessage = `请从以下设备通讯手册文本片段中抽取寄存器点位表：\n\n${segText}`

    const result = await provider.chatCompletion({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      temperature: 0,
      responseFormat: { type: 'json_object' },
    })

    totalTokens += result.usage.totalTokens

    // 解析 JSON
    let parsed
    try {
      parsed = JSON.parse(result.content)
    } catch {
      // 尝试 JSON 修复
      try {
        const repaired = repairJson(result.content)
        parsed = JSON.parse(repaired)
      } catch {
        // 无法解析，跳过本段
        if (onProgress) {
          onProgress({
            segment: i + 1,
            totalSegments: segments.length,
            accumulatedPoints: allRawPoints.length,
            accumulatedTokens: totalTokens,
          })
        }
        continue
      }
    }

    const rawPoints = Array.isArray(parsed?.points) ? parsed.points : []
    allRawPoints.push(...rawPoints)

    if (onProgress) {
      onProgress({
        segment: i + 1,
        totalSegments: segments.length,
        accumulatedPoints: allRawPoints.length,
        accumulatedTokens: totalTokens,
      })
    }
  }

  // 后处理：转换 + 去重 + 校验
  const { points: converted, dropped: convertDropped } = convertPoints(allRawPoints)

  // Codec.validatePoints 终审
  const validation = validatePoints(converted)
  const finalPoints = validation.ok ? validation.points : []

  const addrAmbiguityWarning = checkAddrAmbiguity(allRawPoints)

  return {
    points: finalPoints,
    stats: {
      totalSegments: segments.length,
      totalTokens,
      droppedInvalid: convertDropped + (converted.length - finalPoints.length),
      addrAmbiguityWarning,
    },
  }
}

module.exports = {
  extractPoints,
  segmentText,
  repairJson,
  convertPoints,
  addrHexToDecimal,
  checkAddrAmbiguity,
  buildSystemPrompt,
  SEGMENT_MAX_CHARS,
  SEGMENT_OVERLAP_CHARS,
}
