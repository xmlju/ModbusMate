// renderer/llm-wizard-state.js — LLM 点表向导的步骤状态转移纯函数（UMD）
// 向导共 4 步：选择文件→检查设置→文档解析→预览保存
const LlmWizardState = (() => {

/** 向导步骤序号（从 1 开始） */
const STEPS = Object.freeze([
  { id: 1, label: '选择文件' },
  { id: 2, label: '检查设置' },
  { id: 3, label: '文档解析' },
  { id: 4, label: '预览保存' },
])

const TOTAL_STEPS = STEPS.length
const FIRST_STEP = 1
const LAST_STEP = TOTAL_STEPS

/** 获取步骤标签 */
function stepLabel(stepId) {
  const s = STEPS.find(s => s.id === stepId)
  return s ? s.label : `步骤 ${stepId}`
}

// ═══════════════════════════════════════════════
// 状态转移
// ═══════════════════════════════════════════════

/**
 * 判断当前步能否前进。
 * 规则：
 * - 第 1 步（选择文件）：已有 docId 说明文件已抽取，可前进
 * - 第 2 步（检查设置）：始终可前进（步骤 3 自行校验 Key）
 * - 第 3 步（文档解析）：正在解析时不可前进；解析完毕后（points.length>0）可前进
 * - 第 4 步（预览保存）：最后一步，不可前进
 * - inProgress 为 true 时一律不可前进
 *
 * @param {number} stepId - 当前步骤 (1-4)
 * @param {object} state
 * @param {boolean} [state.inProgress=false] - 是否有进行中的操作
 * @param {string|null} [state.docId=null] - 文档缓存 ID
 * @param {Array} [state.points=[]] - 已抽取的点位
 * @returns {boolean}
 */
function canAdvance(stepId, state = {}) {
  if (typeof stepId !== 'number' || stepId < FIRST_STEP || stepId > LAST_STEP) return false
  if (state.inProgress) return false
  if (stepId === LAST_STEP) return false

  switch (stepId) {
    case 1:
      return typeof state.docId === 'string' && state.docId.length > 0
    case 3:
      return Array.isArray(state.points) && state.points.length > 0
    default:
      return true
  }
}

/**
 * 判断当前步能否后退。
 * 规则：
 * - 第 1 步：首步，不可后退
 * - inProgress 为 true 时不可后退（防止操作进行中中断）
 * - 其余步骤可后退
 *
 * @param {number} stepId
 * @param {object} state
 * @param {boolean} [state.inProgress=false]
 * @returns {boolean}
 */
function canGoBack(stepId, state = {}) {
  if (typeof stepId !== 'number' || stepId < FIRST_STEP || stepId > LAST_STEP) return false
  if (state.inProgress) return false
  return stepId > FIRST_STEP
}

/**
 * 获取下一步 ID（不做可行性判断，仅计算）。
 * @param {number} stepId
 * @returns {number|null}
 */
function nextStep(stepId) {
  if (typeof stepId !== 'number' || stepId < FIRST_STEP || stepId >= LAST_STEP) return null
  return stepId + 1
}

/**
 * 获取上一步 ID（不做可行性判断，仅计算）。
 * @param {number} stepId
 * @returns {number|null}
 */
function prevStep(stepId) {
  if (typeof stepId !== 'number' || stepId <= FIRST_STEP || stepId > LAST_STEP) return null
  return stepId - 1
}

/**
 * 判断当前步骤是否为"进行中"步骤（需要显示 loading/spinner）。
 * @param {number} stepId
 * @returns {boolean}
 */
function isAsyncStep(stepId) {
  return stepId === 3
}

// ═══════════════════════════════════════════════
return { STEPS, TOTAL_STEPS, FIRST_STEP, LAST_STEP, stepLabel, canAdvance, canGoBack, nextStep, prevStep, isAsyncStep }
})()

if (typeof window !== 'undefined') window.LlmWizardState = LlmWizardState
if (typeof module !== 'undefined') module.exports = LlmWizardState
