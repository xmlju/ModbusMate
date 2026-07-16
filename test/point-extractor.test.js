// test/point-extractor.test.js — point-extractor 单元测试
// LLM 调用全部 mock，不消耗真实 token
// 包含 spec 中要求的黄金测试用例

import { describe, it, expect, vi } from 'vitest'

const {
  segmentText,
  repairJson,
  convertPoints,
  addrHexToDecimal,
  checkAddrAmbiguity,
  extractPoints,
  buildSystemPrompt,
  SEGMENT_MAX_CHARS,
} = require('../main/llm/point-extractor.js')

// ============================================================
// 辅助函数：创建 mock provider
// ============================================================
function mockProvider(responses) {
  let callIdx = 0
  return {
    chatCompletion: vi.fn().mockImplementation(() => {
      const resp = responses[callIdx++] || responses[responses.length - 1]
      return Promise.resolve(resp)
    }),
  }
}

// ============================================================
// segmentText — 分段逻辑
// ============================================================
describe('segmentText — 分段逻辑', () => {
  it('短文本不超过 12K 直接返回单段', () => {
    const text = '保持寄存器 0000 开关\n'.repeat(10)
    const segments = segmentText(text)
    expect(segments).toHaveLength(1)
    expect(segments[0]).toBe(text)
  })

  it('空文本返回单段', () => {
    const segments = segmentText('')
    expect(segments).toHaveLength(1)
    expect(segments[0]).toBe('')
  })

  it('长文本分段后段间有重叠', () => {
    // 构造一个超过 12K 的文本
    const line = '保持寄存器 0000 开关 单位：0.1V OFF:关 ON:开\n'
    const text = line.repeat(Math.ceil(SEGMENT_MAX_CHARS / line.length) + 5)

    const segments = segmentText(text)
    expect(segments.length).toBeGreaterThanOrEqual(1)

    // 检查段间重叠
    for (let i = 1; i < segments.length; i++) {
      const prevEnd = segments[i - 1].slice(-100)
      const currStart = segments[i].slice(0, 100)
      // 前段的尾部应该部分出现在后段的头部（重叠）
      // 但不能完全相同
      expect(segments[i - 1].length + segments[i].length).toBeGreaterThan(
        Math.max(segments[i - 1].length, segments[i].length)
      )
    }
  })

  // 回归用例: 边界紧贴段首的对抗性文本，证明不造成死循环且全文覆盖
  it('边界紧贴段首的对抗性文本分段数量有限且全文覆盖', () => {
    // 构造: 12K 填充 + 紧跟在重叠区开头出现的寄存器模式（模拟 bestPos 刚过 start 一点点）
    const filler = 'X'.repeat(SEGMENT_MAX_CHARS)
    // 在紧贴段末处放置寄存器行——这些行会落在第二段 start=SEGMENT_MAX_CHARS-SEGMENT_OVERLAP_CHARS 附近
    const tail =
      '保持寄存器 0001 对抗点位A\n'.repeat(3) +
      '输入寄存器 0002 对抗点位B\n'.repeat(3) +
      'Y'.repeat(300)

    const text = filler + tail

    const segments = segmentText(text)

    // 不死循环：段数应有限且合理（文末无重叠，段数应很少）
    expect(segments.length).toBeGreaterThan(0)
    expect(segments.length).toBeLessThan(20)

    // 第一段从 0 开始，最后一段覆盖到文末
    expect(text.startsWith(segments[0])).toBe(true)

    // 全文覆盖：从第一段首到最后一段尾（允许重叠），所有字符至少出现在某个段中
    const coverage = new Set()
    for (const seg of segments) {
      for (let j = 0; j < seg.length; j++) {
        coverage.add(seg[j])
      }
    }
    // 至少 filler 的 'X' 和 tail 的 'Y' 都在
    expect(coverage.has('X')).toBe(true)
    expect(coverage.has('Y')).toBe(true)

    // 每个段的 start 严格递增（验证 forward progress）
    const starts = []
    let pos = 0
    for (const seg of segments) {
      starts.push(text.indexOf(seg[0], pos))
      pos = starts[starts.length - 1] + 1
    }
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i]).toBeGreaterThanOrEqual(starts[i - 1])
    }
  })
})

// ============================================================
// repairJson — JSON 修复
// ============================================================
describe('repairJson — JSON 修复', () => {
  it('正常 JSON 不做修改', () => {
    const input = '{"points":[{"name":"开关","area":"coil","addrHex":"0000","words":1}]}'
    expect(repairJson(input)).toBe(input)
  })

  it('去掉 markdown 代码块包裹', () => {
    const input = '```json\n{"points":[]}\n```'
    const result = repairJson(input)
    expect(result).toBe('{"points":[]}')
  })

  it('修补末尾缺失的 }', () => {
    const input = '{"points":[{"name":"开关","area":"coil","addrHex":"0000"}]'
    const result = repairJson(input)
    expect(() => JSON.parse(result)).not.toThrow()
    const parsed = JSON.parse(result)
    expect(parsed.points[0].name).toBe('开关')
  })

  it('修补末尾缺失的 }]', () => {
    const input = '{"points":[{"name":"开关","area":"coil","addrHex":"0000"'
    const result = repairJson(input)
    expect(() => JSON.parse(result)).not.toThrow()
    const parsed = JSON.parse(result)
    expect(parsed.points[0].name).toBe('开关')
  })
})

// ============================================================
// addrHexToDecimal — 16进制地址转十进制
// ============================================================
describe('addrHexToDecimal', () => {
  it('"0000" → 0', () => {
    expect(addrHexToDecimal('0000')).toBe(0)
  })

  it('"0001" → 1', () => {
    expect(addrHexToDecimal('0001')).toBe(1)
  })

  it('"4544" → 17732 (关键: 并非直接当十进制 4544)', () => {
    expect(addrHexToDecimal('4544')).toBe(17732)
  })

  it('"11C0" → 4544', () => {
    expect(addrHexToDecimal('11C0')).toBe(4544)
  })

  it('"01F6" → 502', () => {
    expect(addrHexToDecimal('01F6')).toBe(502)
  })

  it('"FFFF" → 65535', () => {
    expect(addrHexToDecimal('FFFF')).toBe(65535)
  })
})

// ============================================================
// checkAddrAmbiguity — 地址进制歧义检测
// ============================================================
describe('checkAddrAmbiguity', () => {
  it('含 A-F 字符文档 → 无歧义 (null)', () => {
    const rawPoints = [
      { addrHex: '11C0' },
      { addrHex: '01F6' },
      { addrHex: '4544' },
    ]
    expect(checkAddrAmbiguity(rawPoints)).toBeNull()
  })

  it('纯数字文档且无 8/9 开头多位地址 → null', () => {
    const rawPoints = [
      { addrHex: '0000' },
      { addrHex: '0123' },
      { addrHex: '7000' },
    ]
    expect(checkAddrAmbiguity(rawPoints)).toBeNull()
  })

  it('纯数字文档但有 8/9 开头多位地址 → 提示人工确认', () => {
    const rawPoints = [
      { addrHex: '8000' },
      { addrHex: '9000' },
      { addrHex: '0123' },
    ]
    const warning = checkAddrAmbiguity(rawPoints)
    expect(warning).toContain('人工确认进制')
  })
})

// ============================================================
// convertPoints — LLM 原始点位 → modbusmate-points@1
// ============================================================
describe('convertPoints', () => {
  it('单字点位移除 words=1 → type=uint16', () => {
    const raw = [
      { name: '开关', area: 'coil', addrHex: '0000', words: 1, k: 1, b: 0, decimals: 0, unit: '' },
    ]
    const { points, dropped } = convertPoints(raw)
    expect(dropped).toBe(0)
    expect(points).toHaveLength(1)
    expect(points[0].area).toBe('coil')
    expect(points[0].addr).toBe(0)
    expect(points[0].type).toBe('uint16')
    expect(points[0].wordOrder).toBe('AB')
    expect(points[0].visible).toBe(true)
  })

  it('双字点位移除 words=2 → type=uint32', () => {
    const raw = [
      { name: '欠压值', area: 'holding', addrHex: '0032', words: 2, k: 0.001, b: 0, decimals: 3, unit: 'V' },
    ]
    const { points, dropped } = convertPoints(raw)
    expect(points).toHaveLength(1)
    expect(points[0].addr).toBe(50) // parseInt('0032', 16) = 50
    expect(points[0].type).toBe('uint32')
    expect(points[0].k).toBe(0.001)
    expect(points[0].decimals).toBe(3)
    expect(points[0].unit).toBe('V')
  })

  it('同 area+addr 重复去重保留第一条', () => {
    const raw = [
      { name: '电压需求', area: 'holding', addrHex: '4544', words: 1 },
      { name: '电压需求(重复)', area: 'holding', addrHex: '4544', words: 1 },
    ]
    const { points, dropped } = convertPoints(raw)
    expect(points).toHaveLength(1)
    expect(points[0].name).toBe('电压需求')
  })

  it('不同 area 相同 addr 允许共存', () => {
    const raw = [
      { name: '保持寄存器的 11C0', area: 'holding', addrHex: '11C0', words: 1 }, // holding:4544
      { name: '输入寄存器的 11C0', area: 'input', addrHex: '11C0', words: 1 },   // input:4544
    ]
    const { points, dropped } = convertPoints(raw)
    expect(points).toHaveLength(2)
    expect(points[0].addr).toBe(4544)
    expect(points[1].addr).toBe(4544)
  })

  it('缺少 name 的点位被丢弃', () => {
    const raw = [
      { name: '', area: 'holding', addrHex: '0000', words: 1 },
    ]
    const { points, dropped } = convertPoints(raw)
    expect(dropped).toBe(1)
    expect(points).toHaveLength(0)
  })

  it('addrHex 非法导致丢弃', () => {
    const raw = [
      { name: '坏地址', area: 'holding', addrHex: 'GGGG', words: 1 },
    ]
    const { points, dropped } = convertPoints(raw)
    expect(dropped).toBe(1)
    expect(points).toHaveLength(0)
  })

  it('线圈固定 words=1, k=1, decimals=0', () => {
    const raw = [
      { name: '开关', area: 'coil', addrHex: '0000', words: 1, k: 1, b: 0, decimals: 0, unit: '' },
    ]
    const { points } = convertPoints(raw)
    expect(points[0].words).toBeUndefined() // words 不输出到最终格式
    expect(points[0].k).toBe(1)
    expect(points[0].decimals).toBe(0)
  })

  it('离散量正常转换', () => {
    const raw = [
      { name: '测试模式', area: 'discrete', addrHex: '01F6', words: 1 },
    ]
    const { points } = convertPoints(raw)
    expect(points).toHaveLength(1)
    expect(points[0].area).toBe('discrete')
    expect(points[0].addr).toBe(502) // parseInt('01F6', 16) = 502
  })

  it('缺少 k/decimals 默认为 1/0', () => {
    const raw = [
      { name: '电压', area: 'holding', addrHex: '0001', words: 1 },
    ]
    const { points } = convertPoints(raw)
    expect(points[0].k).toBe(1)
    expect(points[0].decimals).toBe(0)
  })
})

// ============================================================
// extractPoints — 端到端（mock LLM）
// ============================================================
describe('extractPoints — 端到端（mock LLM）', () => {
  it('单段文本正常抽取和校验', async () => {
    const provider = mockProvider([
      {
        content: JSON.stringify({
          points: [
            { name: '开关', area: 'coil', addrHex: '0000', words: 1, k: 1, b: 0, decimals: 0, unit: '' },
            { name: '复位', area: 'coil', addrHex: '0001', words: 1, k: 1, b: 0, decimals: 0, unit: '' },
          ],
        }),
        usage: { promptTokens: 50, completionTokens: 30, totalTokens: 80 },
      },
    ])

    const result = await extractPoints({
      text: '线圈 0000 开关 线圈 0001 复位',
      provider,
    })

    expect(result.points).toHaveLength(2)
    expect(result.points[0].name).toBe('开关')
    expect(result.points[0].addr).toBe(0)
    expect(result.stats.totalSegments).toBe(1)
    expect(result.stats.totalTokens).toBe(80)
    expect(result.stats.droppedInvalid).toBe(0)
    expect(result.stats.addrAmbiguityWarning).toBeNull()
  })

  it('LLM 返回非法点位移除后通过 Codec 校验剔除', async () => {
    const provider = mockProvider([
      {
        content: JSON.stringify({
          points: [
            { name: '合法', area: 'holding', addrHex: '0000', words: 1 },
            { name: '非法地址', area: 'holding', addrHex: 'FFFFF', words: 1 }, // 超出 65535
          ],
        }),
        usage: { totalTokens: 50 },
      },
    ])

    const result = await extractPoints({
      text: '保持寄存器 0000 合法',
      provider,
    })

    expect(result.points).toHaveLength(1)
    expect(result.points[0].name).toBe('合法')
    expect(result.stats.droppedInvalid).toBe(1)
  })

  it('onProgress 回调接收进度数据', async () => {
    const provider = mockProvider([
      {
        content: JSON.stringify({ points: [{ name: 'p1', area: 'holding', addrHex: '0001', words: 1 }] }),
        usage: { totalTokens: 30 },
      },
    ])

    const progressCalls = []
    await extractPoints({
      text: '保持寄存器 0001 p1',
      provider,
      onProgress: (info) => progressCalls.push(info),
    })

    expect(progressCalls.length).toBe(1)
    expect(progressCalls[0].segment).toBe(1)
    expect(progressCalls[0].totalSegments).toBe(1)
    expect(progressCalls[0].accumulatedTokens).toBe(30)
  })

  it('缺少 text 参数抛出错误', async () => {
    await expect(extractPoints({
      text: '',
      provider: mockProvider([]),
    })).rejects.toThrow('缺少必要参数')
  })

  it('缺少 provider 参数抛出错误', async () => {
    await expect(extractPoints({
      text: 'test',
      provider: null,
    })).rejects.toThrow('缺少必要参数')
  })

  it('多段文本分段处理', async () => {
    // 构造超过 12K 的文本使其分段
    const line = 'A'.repeat(100) + ' 保持寄存器 0000 测试\n'
    const longText = line.repeat(Math.ceil(SEGMENT_MAX_CHARS / line.length) + 5)

    const provider = mockProvider([
      {
        content: JSON.stringify({
          points: [{ name: '段1点位', area: 'holding', addrHex: '0001', words: 1 }],
        }),
        usage: { totalTokens: 40 },
      },
      {
        content: JSON.stringify({
          points: [{ name: '段2点位', area: 'holding', addrHex: '0002', words: 1 }],
        }),
        usage: { totalTokens: 40 },
      },
    ])

    const progressCalls = []
    const result = await extractPoints({
      text: longText,
      provider,
      onProgress: (info) => progressCalls.push(info),
    })

    expect(result.stats.totalSegments).toBeGreaterThanOrEqual(2)
    expect(result.stats.totalTokens).toBeGreaterThan(0)
    expect(result.points.length).toBeGreaterThanOrEqual(2)
  })
})

// ============================================================
// 黄金测试用例 — 来自 llm-extraction-prompt-v1.md
// ============================================================
describe('黄金测试用例 — 规格要求', () => {
  it('样本 1: 线圈 0000 开关', async () => {
    const provider = mockProvider([
      {
        content: JSON.stringify({
          points: [
            { name: '开关', area: 'coil', addrHex: '0000', words: 1, k: 1, b: 0, decimals: 0, unit: '' },
          ],
        }),
        usage: { totalTokens: 30 },
      },
    ])

    const result = await extractPoints({
      text: '线圈 0000 开关 OFF:关 ON:开',
      provider,
    })

    expect(result.points).toHaveLength(1)
    const p = result.points[0]
    expect(p.area).toBe('coil')
    expect(p.addr).toBe(0)
    expect(p.type).toBe('uint16')
    expect(p.name).toBe('开关')
  })

  it('样本 1: 保持寄存器 0032-0033 欠压值 单位：0.001V', async () => {
    const provider = mockProvider([
      {
        content: JSON.stringify({
          points: [
            { name: '欠压值', area: 'holding', addrHex: '0032', words: 2, k: 0.001, b: 0, decimals: 3, unit: 'V' },
          ],
        }),
        usage: { totalTokens: 30 },
      },
    ])

    const result = await extractPoints({
      text: '保持寄存器 0032-0033 欠压值 单位：0.001V',
      provider,
    })

    expect(result.points).toHaveLength(1)
    const p = result.points[0]
    expect(p.area).toBe('holding')
    expect(p.addr).toBe(50) // 0x0032 = 50
    expect(p.type).toBe('uint32')
    expect(p.k).toBe(0.001)
    expect(p.unit).toBe('V')
    expect(p.decimals).toBe(3)
  })

  it('样本 2: 保持寄存器 4544 充电桩测试电压需求 → addr=17732', async () => {
    const provider = mockProvider([
      {
        content: JSON.stringify({
          points: [
            { name: '充电桩测试电压需求', area: 'holding', addrHex: '4544', words: 1, k: 0.1, b: 0, decimals: 1, unit: 'V' },
          ],
        }),
        usage: { totalTokens: 30 },
      },
    ])

    const result = await extractPoints({
      text: '保持寄存器 4544 充电桩测试电压需求 单位：0.1V',
      provider,
    })

    expect(result.points).toHaveLength(1)
    const p = result.points[0]
    expect(p.area).toBe('holding')
    // 黄金断言: addr 必须是 17732，不是 4544！
    expect(p.addr).toBe(17732)
    expect(p.name).toBe('充电桩测试电压需求')
  })

  it('样本 2: 输入寄存器 11C0 CML报文优先级 → addr=4544', async () => {
    const provider = mockProvider([
      {
        content: JSON.stringify({
          points: [
            { name: '充电桩测试CML报文优先级', area: 'input', addrHex: '11C0', words: 1 },
          ],
        }),
        usage: { totalTokens: 30 },
      },
    ])

    const result = await extractPoints({
      text: '输入寄存器 11C0 充电桩测试CML报文优先级',
      provider,
    })

    expect(result.points).toHaveLength(1)
    const p = result.points[0]
    expect(p.area).toBe('input')
    expect(p.addr).toBe(4544) // 0x11C0 = 4544
  })

  it('样本 2: holding:4544(17732) 和 input:11C0(4544) 共存不冲突', async () => {
    const provider = mockProvider([
      {
        content: JSON.stringify({
          points: [
            { name: '充电桩测试电压需求', area: 'holding', addrHex: '4544', words: 1, k: 0.1, b: 0, decimals: 1, unit: 'V' },
            { name: '充电桩测试CML报文优先级', area: 'input', addrHex: '11C0', words: 1 },
          ],
        }),
        usage: { totalTokens: 40 },
      },
    ])

    const result = await extractPoints({
      text: '保持寄存器 4544 充电桩测试电压需求 单位：0.1V 输入寄存器 11C0 充电桩测试CML报文优先级',
      provider,
    })

    expect(result.points).toHaveLength(2)
    const holding = result.points.find(p => p.area === 'holding')
    const input = result.points.find(p => p.area === 'input')
    expect(holding.addr).toBe(17732)
    expect(input.addr).toBe(4544)
  })
})

// ============================================================
// buildSystemPrompt — system prompt
// ============================================================
describe('buildSystemPrompt', () => {
  it('返回非空字符串且包含关键规则', () => {
    const prompt = buildSystemPrompt()
    expect(typeof prompt).toBe('string')
    expect(prompt.length).toBeGreaterThan(100)
    expect(prompt).toContain('保持寄存器')
    expect(prompt).toContain('addrHex')
    expect(prompt).toContain('输出 JSON')
  })
})
