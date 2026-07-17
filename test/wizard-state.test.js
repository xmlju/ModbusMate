// test/wizard-state.test.js — wizard-state 向导状态转移纯函数单测

import { describe, it, expect } from 'vitest'

const {
  STEPS,
  TOTAL_STEPS,
  FIRST_STEP,
  LAST_STEP,
  stepLabel,
  canAdvance,
  canGoBack,
  nextStep,
  prevStep,
  isAsyncStep,
} = require('../renderer/llm-wizard-state.js')

// ═══════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════
describe('STEPS 常量', () => {
  it('共 4 步', () => {
    expect(STEPS).toHaveLength(4)
    expect(TOTAL_STEPS).toBe(4)
  })

  it('步骤 id 连续 1~4', () => {
    const ids = STEPS.map(s => s.id)
    expect(ids).toEqual([1, 2, 3, 4])
  })

  it('FIRST_STEP = 1, LAST_STEP = 4', () => {
    expect(FIRST_STEP).toBe(1)
    expect(LAST_STEP).toBe(4)
  })

  it('每步有中文标签', () => {
    STEPS.forEach(s => {
      expect(typeof s.label).toBe('string')
      expect(s.label.length).toBeGreaterThan(0)
    })
  })
})

// ═══════════════════════════════════════════════
// stepLabel
// ═══════════════════════════════════════════════
describe('stepLabel', () => {
  it('返回各步中文标签', () => {
    expect(stepLabel(1)).toBe('选择文件')
    expect(stepLabel(2)).toBe('检查设置')
    expect(stepLabel(3)).toBe('文档解析')
    expect(stepLabel(4)).toBe('预览保存')
  })

  it('越界或非法值返回后备文案', () => {
    expect(stepLabel(0)).toBe('步骤 0')
    expect(stepLabel(5)).toBe('步骤 5')
    expect(stepLabel('x')).toBe('步骤 x')
  })
})

// ═══════════════════════════════════════════════
// nextStep / prevStep
// ═══════════════════════════════════════════════
describe('nextStep / prevStep', () => {
  it('正常递增递减', () => {
    for (let i = 1; i < 4; i++) {
      expect(nextStep(i)).toBe(i + 1)
      expect(prevStep(i + 1)).toBe(i)
    }
  })

  it('边界：第 1 步 prevStep = null', () => {
    expect(prevStep(1)).toBeNull()
  })

  it('边界：第 4 步 nextStep = null', () => {
    expect(nextStep(4)).toBeNull()
  })

  it('越界返回 null', () => {
    expect(nextStep(0)).toBeNull()
    expect(prevStep(5)).toBeNull()
    expect(nextStep('x')).toBeNull()
  })
})

// ═══════════════════════════════════════════════
// canAdvance
// ═══════════════════════════════════════════════
describe('canAdvance', () => {
  describe('通用约束', () => {
    it('越界步返回 false', () => {
      expect(canAdvance(0)).toBe(false)
      expect(canAdvance(5)).toBe(false)
    })

    it('inProgress=true 时一律 false', () => {
      for (let i = 1; i <= 3; i++) {
        expect(canAdvance(i, { inProgress: true })).toBe(false)
      }
    })

    it('最后一步始终 false', () => {
      expect(canAdvance(4, { points: [1, 2, 3] })).toBe(false)
    })
  })

  describe('第 1 步（选择文件）', () => {
    it('有 docId 可前进', () => {
      expect(canAdvance(1, { docId: 'abc-123' })).toBe(true)
    })

    it('无 docId 不可前进', () => {
      expect(canAdvance(1, {})).toBe(false)
      expect(canAdvance(1, { docId: '' })).toBe(false)
      expect(canAdvance(1, { docId: null })).toBe(false)
    })
  })

  describe('第 2 步（检查设置）：始终可前进', () => {
    it('无额外条件始终可前进', () => {
      expect(canAdvance(2, {})).toBe(true)
    })
  })

  describe('第 3 步（文档解析）', () => {
    it('有 points 数组可前进', () => {
      expect(canAdvance(3, { points: [{ name: 'a' }] })).toBe(true)
    })

    it('points 为空数组不可前进', () => {
      expect(canAdvance(3, { points: [] })).toBe(false)
    })

    it('points 缺失不可前进', () => {
      expect(canAdvance(3, {})).toBe(false)
    })
  })
})

// ═══════════════════════════════════════════════
// canGoBack
// ═══════════════════════════════════════════════
describe('canGoBack', () => {
  it('第 1 步不可后退', () => {
    expect(canGoBack(1)).toBe(false)
  })

  it('第 2-4 步无 inProgress 时可后退', () => {
    for (let i = 2; i <= 4; i++) {
      expect(canGoBack(i)).toBe(true)
    }
  })

  it('inProgress=true 时第 2-4 步不可后退', () => {
    for (let i = 2; i <= 4; i++) {
      expect(canGoBack(i, { inProgress: true })).toBe(false)
    }
  })

  it('越界步返回 false', () => {
    expect(canGoBack(0)).toBe(false)
    expect(canGoBack(5)).toBe(false)
  })

  it('典型场景：第 3 步解析失败后可回第 2 步重试', () => {
    // 解析完成后 inProgress=false，可以后退
    expect(canGoBack(3, { inProgress: false })).toBe(true)
  })

  it('典型场景：第 3 步解析中不可后退', () => {
    expect(canGoBack(3, { inProgress: true })).toBe(false)
  })
})

// ═══════════════════════════════════════════════
// isAsyncStep
// ═══════════════════════════════════════════════
describe('isAsyncStep', () => {
  it('第 3 步是异步步骤', () => {
    expect(isAsyncStep(3)).toBe(true)
  })

  it('其余步骤不是异步', () => {
    expect(isAsyncStep(1)).toBe(false)
    expect(isAsyncStep(2)).toBe(false)
    expect(isAsyncStep(4)).toBe(false)
  })
})

// ═══════════════════════════════════════════════
// 端到端：完整向导流程推演
// ═══════════════════════════════════════════════
describe('完整向导流程推演', () => {
  it('正常流程 1→2→3→4', () => {
    const state = { docId: null, points: [], inProgress: false }

    // Step 1: 尚未选择文件
    expect(canAdvance(1, state)).toBe(false)
    state.docId = 'doc-001' // 用户选择了文件
    expect(canAdvance(1, state)).toBe(true)
    expect(prevStep(1)).toBeNull()
    expect(nextStep(1)).toBe(2)

    // Step 2: 检查设置
    expect(canAdvance(2, state)).toBe(true)
    expect(canGoBack(2, state)).toBe(true)

    // Step 3: 解析进行中
    state.inProgress = true // 点击解析按钮
    expect(canAdvance(3, state)).toBe(false)
    expect(canGoBack(3, state)).toBe(false)
    state.inProgress = false
    state.points = [1, 2, 3] // 解析成功
    expect(canAdvance(3, state)).toBe(true)
    expect(canGoBack(3, state)).toBe(true)

    // Step 4: 预览保存（最后一步）
    expect(canAdvance(4, state)).toBe(false)
    expect(canGoBack(4, state)).toBe(true)
  })

  it('解析失败后可回退到第 2 步重试（docId 不丢）', () => {
    const state = { docId: 'doc-001', points: [], inProgress: false }
    // 还在第 3 步，但 points 为空（解析失败）
    expect(canAdvance(3, state)).toBe(false) // 不能前进
    expect(canGoBack(3, state)).toBe(true)   // 但可以后退
    // 回到第 2 步，docId 还在
    expect(canAdvance(1, state)).toBe(true)
  })
})
