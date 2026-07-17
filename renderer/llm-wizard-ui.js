// renderer/llm-wizard-ui.js — LLM 点表向导 UI（UMD）
// 浏览器：<script> 引入后使用全局 LlmWizardUI.init()；Vitest：module.exports 加载
// 依赖：$（DOM 查询）、LlmWizardState、LlmUtils、window.api、DeviceUI、Codec
const LlmWizardUI = (() => {

const $ = id => document.getElementById(id)

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// ═══════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════

// 与后端 main/llm/llm-service.js 的 ALLOWED_EXTENSIONS 保持一致
const ALLOWED_EXTENSIONS = ['.pdf', '.docx', '.doc', '.txt']
const MAX_FILE_SIZE = 20 * 1024 * 1024 // 20 MiB
const SETTINGS_KEY = 'modbusmate.llmSettings'

// ═══════════════════════════════════════════════
// 状态
// ═══════════════════════════════════════════════

const state = {
  step: 1,            // 1-4
  docId: null,        // 由 llmExtractText 返回
  fileName: null,
  charCount: 0,
  inProgress: false,
  points: [],         // 解析出的点位
  stats: {},          // 解析统计
  totalTokens: 0,
  totalSegments: 0,
  canAdvance: false,
  canGoBack: false,
}

// 进度监听器注销句柄，用于防重复注册
let _progressUnsub = null

// ═══════════════════════════════════════════════
// 状态重置
// ═══════════════════════════════════════════════
// 注：弹窗 HTML 静态写在 renderer/index.html（#llmWizardModal），与项目其他弹窗保持一致；
// 本文件只操作其中的元素，两边 ID 必须同步维护

function resetState() {
  state.step = 1
  state.docId = null
  state.fileName = null
  state.charCount = 0
  state.inProgress = false
  state.points = []
  state.stats = {}
  state.totalTokens = 0
  state.totalSegments = 0
  state.canAdvance = false
  state.canGoBack = false
  _cleanupProgress()
}

function _cleanupProgress() {
  if (typeof _progressUnsub === 'function') {
    try { _progressUnsub() } catch { /* ignore */ }
  }
  _progressUnsub = null
}

// ═══════════════════════════════════════════════
// 弹窗开关
// ═══════════════════════════════════════════════

function openModal() {
  // 加载设置：config.json 优先，localStorage 兜底
  loadSettings().then(settings => {
    if (settings.baseURL) $('llmBaseUrl').value = settings.baseURL
    if (settings.apiKey) $('llmApiKey').value = settings.apiKey
    if (settings.model) $('llmModel').value = settings.model
  }).catch(() => { /* 设置加载失败不影响向导打开 */ })

  resetState()

  // 重置上传区域
  const uploadArea = $('llmUploadArea')
  const filePreview = $('llmFilePreview')
  if (uploadArea) uploadArea.classList.remove('disabled')
  if (uploadArea) uploadArea.style.pointerEvents = ''
  if (filePreview) filePreview.classList.add('hidden')

  // 重置解析区域
  const parseIdle = $('llmParseIdle')
  const progressWrap = $('llmParseProgress')
  const parseError = $('llmParseError')
  const retryBtn = $('llmRetryBtn')
  if (parseIdle) {
    parseIdle.classList.remove('hidden')
    parseIdle.innerHTML = '<p>已就绪，点击下方按钮开始解析</p><p class="hint" id="llmDocInfo"></p>'
  }
  if (progressWrap) progressWrap.classList.add('hidden')
  if (parseError) { parseError.classList.add('hidden'); parseError.textContent = '' }
  if (retryBtn) retryBtn.classList.add('hidden')

  goToStep(1)
  $('llmWizardModal').classList.remove('hidden')
}

function closeModal(checkConfirm) {
  if (checkConfirm && state.inProgress) {
    if (!confirm('正在解析中，确定要关闭吗？')) return
  }
  _cleanupProgress()
  $('llmWizardModal').classList.add('hidden')
}

// ═══════════════════════════════════════════════
// 设置加载与持久化
// ═══════════════════════════════════════════════

async function loadSettings() {
  // 从 localStorage 加载
  let local = {}
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (raw) local = JSON.parse(raw)
  } catch { local = {} }

  // 从 config.json 加载 llm 字段（优先级更高）
  let config = {}
  try {
    const cfg = await window.api.loadConfig()
    if (cfg && cfg.llm && typeof cfg.llm === 'object') config = cfg.llm
  } catch { /* config.json 不可用时忽略 */ }

  // 合并：config.json 胜出
  return { ...local, ...config }
}

function saveSettingsToLocal() {
  const settings = {
    baseURL: ($('llmBaseUrl')?.value || '').trim(),
    apiKey: ($('llmApiKey')?.value || '').trim(),
    model: ($('llmModel')?.value || '').trim(),
  }
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)) } catch { /* 存储不可用 */ }
}

async function saveSettingsToConfig() {
  const cfg = await window.api.loadConfig()
  const llm = {
    baseURL: ($('llmBaseUrl')?.value || '').trim(),
    apiKey: ($('llmApiKey')?.value || '').trim(),
    model: ($('llmModel')?.value || '').trim(),
  }
  await window.api.saveConfig({ ...cfg, llm })
}

/** 测试连接：发一条最小请求验证 baseURL/Key/模型名，结果显示在按钮旁 */
async function onTestConnection() {
  const btn = $('llmTestBtn')
  const out = $('llmTestResult')
  if (!out) return

  const baseURL = ($('llmBaseUrl')?.value || '').trim()
  const apiKey = ($('llmApiKey')?.value || '').trim()
  const model = ($('llmModel')?.value || '').trim()

  if (!baseURL || !apiKey) {
    out.textContent = '请先填写 baseURL 和 API Key'
    out.style.color = 'var(--status-critical)'
    return
  }

  if (btn) btn.disabled = true
  out.textContent = '测试中…'
  out.style.color = ''
  try {
    const r = await window.api.llmTestConnection({ baseURL, apiKey, model })
    out.textContent = `✓ 连接成功：${r.model} · ${r.latencyMs}ms · 消耗 ${r.totalTokens} tokens`
    out.style.color = 'var(--status-good)'
  } catch (err) {
    // 常见错误直接透传原文：模型名不存在(400)、Key 无效(401)、网络不通等
    out.textContent = `✗ 测试失败：${cleanErr(String(err.message || err))}`
    out.style.color = 'var(--status-critical)'
  } finally {
    if (btn) btn.disabled = false
  }
}

// ═══════════════════════════════════════════════
// 步骤导航
// ═══════════════════════════════════════════════

function goToStep(stepId) {
  state.step = stepId

  // 更新步骤指示器
  const steps = document.querySelectorAll('#llmSteps .llm-step')
  steps.forEach(el => {
    const s = Number(el.dataset.step)
    el.classList.toggle('active', s === stepId)
    el.classList.toggle('done', s < stepId)
  })

  // 切换面板
  for (let i = 1; i <= 4; i++) {
    const pane = $('llmPane' + i)
    if (pane) pane.classList.toggle('hidden', i !== stepId)
  }

  updateNav()
}

function updateNav() {
  const backBtn = $('llmBackBtn')
  const nextBtn = $('llmNextBtn')
  const cancelBtn = $('llmCancelBtn')

  const canAdv = LlmWizardState.canAdvance(state.step, {
    docId: state.docId,
    points: state.points,
    inProgress: state.inProgress,
  })
  const canBack = LlmWizardState.canGoBack(state.step, { inProgress: state.inProgress })

  backBtn.classList.toggle('hidden', !canBack)
  nextBtn.disabled = !canAdv && state.step !== 3 // step 3 用 onParse 控制，不是 canAdvance
  nextBtn.classList.toggle('disabled', !canAdv && state.step !== 3)

  // 步骤 4：按钮文字改为"保存为新类型"
  if (state.step === 4) {
    nextBtn.textContent = '保存为新类型'
    nextBtn.disabled = state.inProgress || !Array.isArray(state.points) || state.points.length === 0
  } else if (state.step === 3) {
    // step 3：如果已经解析完有 points，文字改为"下一步到预览"
    if (Array.isArray(state.points) && state.points.length > 0 && !state.inProgress) {
      nextBtn.textContent = '下一步'
      nextBtn.disabled = false
    } else {
      nextBtn.textContent = '开始解析'
      nextBtn.disabled = state.inProgress || !state.docId
    }
  } else {
    nextBtn.textContent = '下一步'
  }
}

// ═══════════════════════════════════════════════
// 步骤 1：文件选择
// ═══════════════════════════════════════════════

function onFileSelected(file) {
  if (!file) return

  // 检查扩展名
  const nameLower = file.name.toLowerCase()
  const extOk = ALLOWED_EXTENSIONS.some(ext => nameLower.endsWith(ext))
  if (!extOk) {
    showStepError(1, `不支持的文件格式"${file.name.split('.').pop()}"，请选择 ${ALLOWED_EXTENSIONS.join(' / ')} 格式的文件`)
    return
  }

  // 检查文件大小
  if (file.size > MAX_FILE_SIZE) {
    showStepError(1, `文件大小 ${(file.size / 1024 / 1024).toFixed(1)} MiB 超过限制（最大 20 MiB）`)
    return
  }

  clearStepError(1)

  const reader = new FileReader()
  reader.onload = () => {
    // readAsDataURL 的结果形如 "data:application/msword;base64,xxxx"，取逗号后的纯 base64。
    // 注意：这里绝不能用 readAsArrayBuffer——String(ArrayBuffer) 会变成
    // "[object ArrayBuffer]" 字面量，后端解码出乱字节导致所有格式解析失败
    const dataUrl = reader.result
    const comma = String(dataUrl).indexOf(',')
    if (comma < 0) {
      showStepError(1, '文件读取结果格式异常（缺少 base64 数据），请重试')
      return
    }
    const base64 = String(dataUrl).slice(comma + 1)

    // 分块（大文件场景），再拼回整串传给后端
    const { chunks } = LlmUtils.chunkBase64(base64)
    const dataBase64 = chunks.length ? chunks.join('') : base64

    state.fileName = file.name
    state.inProgress = true
    updateNav()

    window.api.llmExtractText({ fileName: file.name, dataBase64 })
      .then(result => {
        state.docId = result.docId
        state.charCount = result.charCount || 0
        state.inProgress = false

        // 显示文件预览
        showFilePreview(file.name, result)

        // 试用配额提示（高级会员不显示）
        const docInfo = $('llmDocInfo')
        if (docInfo && result.quota && !result.quota.premium) {
          docInfo.textContent = result.quota.remaining > 0
            ? `AI 生成点表为高级会员功能，普通用户可试用 ${result.quota.limit} 次，剩余 ${result.quota.remaining} 次`
            : `试用次数已用完（${result.quota.used}/${result.quota.limit}），请联系作者开通高级会员`
        }
        updateNav()
      })
      .catch(err => {
        state.inProgress = false
        showStepError(1, `文件上传失败：${cleanErr(String(err.message || err))}`)
        updateNav()
      })
  }

  reader.onerror = () => {
    showStepError(1, '文件读取失败，请重试')
  }

  reader.readAsDataURL(file)
}

function showFilePreview(fileName, result) {
  const uploadArea = $('llmUploadArea')
  const filePreview = $('llmFilePreview')

  if (uploadArea) {
    uploadArea.classList.add('disabled')
    uploadArea.style.pointerEvents = 'none'
  }
  if (filePreview) {
    filePreview.classList.remove('hidden')
    $('llmFileName').textContent = fileName
    const format = result.format || fileName.split('.').pop().toUpperCase()
    $('llmCharCount').textContent = (result.charCount || 0).toLocaleString()
    $('llmFileFormat').textContent = String(format).toUpperCase()
    // 全文前 500 字预览，便于确认抽取内容正确
    const previewEl = $('llmTextPreview')
    if (previewEl) previewEl.textContent = result.preview || ''
  }
}

function showStepError(stepId, msg) {
  const pane = $('llmPane' + stepId)
  if (!pane) return
  let errorEl = pane.querySelector('.llm-step-error')
  if (!errorEl) {
    errorEl = document.createElement('div')
    errorEl.className = 'llm-step-error error-text'
    pane.appendChild(errorEl)
  }
  errorEl.textContent = msg
}

function clearStepError(stepId) {
  const pane = $('llmPane' + stepId)
  if (!pane) return
  const errorEl = pane.querySelector('.llm-step-error')
  if (errorEl) errorEl.textContent = ''
}

function cleanErr(msg) {
  return String(msg).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

// ═══════════════════════════════════════════════
// 步骤 3：解析
// ═══════════════════════════════════════════════

function onParse() {
  // 先检查设置
  const baseURL = ($('llmBaseUrl')?.value || '').trim()
  const apiKey = ($('llmApiKey')?.value || '').trim()

  if (!baseURL || !apiKey) {
    goToStep(2)
    showStepError(2, '请先填写 Base URL 和 API Key，再开始解析')
    return
  }

  if (!state.docId) {
    showStepError(3, '请先选择文件')
    return
  }

  if (state.inProgress) return

  // 保存设置到 config.json
  saveSettingsToConfig().catch(() => { /* 保存失败不影响解析 */ })

  // 重置解析界面
  state.inProgress = true
  state.points = []
  state.stats = {}
  state.totalTokens = 0
  state.totalSegments = 0

  const parseIdle = $('llmParseIdle')
  const progressWrap = $('llmParseProgress')
  const parseError = $('llmParseError')
  const retryBtn = $('llmRetryBtn')
  const progressFill = $('llmProgressFill')
  const segCurrent = $('llmSegCurrent')
  const segTotal = $('llmSegTotal')
  const accumPoints = $('llmAccumPoints')
  const accumTokens = $('llmAccumTokens')
  const estCost = $('llmEstCost')

  parseIdle.classList.add('hidden')
  progressWrap.classList.remove('hidden')
  parseError.classList.add('hidden')
  retryBtn.classList.add('hidden')
  progressFill.style.width = '0%'
  segCurrent.textContent = '—'
  segTotal.textContent = '—'
  accumPoints.textContent = '0'
  accumTokens.textContent = '0'
  estCost.textContent = '¥0.00'

  updateNav()

  // 监听进度（后端 llm:progress 事件字段：segment / totalSegments / accumulatedPoints / accumulatedTokens）
  _cleanupProgress()
  _progressUnsub = window.api.onLlmProgress(p => {
    if (!p || p.docId !== state.docId) return

    if (p.segment !== undefined && p.totalSegments) {
      state.totalSegments = p.totalSegments
      const pct = Math.min(100, Math.round((p.segment / p.totalSegments) * 100))
      progressFill.style.width = pct + '%'
      segCurrent.textContent = String(p.segment)
      segTotal.textContent = String(p.totalSegments)
    }

    if (p.accumulatedPoints !== undefined) {
      accumPoints.textContent = Number(p.accumulatedPoints).toLocaleString()
    }
    if (p.accumulatedTokens !== undefined) {
      state.totalTokens = p.accumulatedTokens
    }

    if (state.totalTokens > 0) {
      accumTokens.textContent = state.totalTokens.toLocaleString()
      const { totalCost } = LlmUtils.estimateCost(state.totalTokens)
      estCost.textContent = `¥${totalCost.toFixed(2)}`
    }
  })

  // 发起解析
  window.api.llmExtractPoints({ docId: state.docId })
    .then(result => {
      state.inProgress = false
      state.points = Array.isArray(result.points) ? result.points : []
      state.stats = result.stats || {}
      state.totalTokens = result.stats?.totalTokens || state.totalTokens

      // 隐藏进度，显示完成态
      progressWrap.classList.add('hidden')
      parseIdle.classList.remove('hidden')
      parseIdle.innerHTML = `<p class="good">解析完成，共提取 ${state.points.length} 个点位</p>`

      _cleanupProgress()
      updateNav()

      // 自动跳转到步骤 4
      goToStep(4)
      renderPreview()
    })
    .catch(err => {
      state.inProgress = false
      _cleanupProgress()

      progressWrap.classList.add('hidden')
      parseIdle.classList.add('hidden')
      parseError.classList.remove('hidden')
      parseError.innerHTML = `<p class="crit">解析失败：${escapeHtml(cleanErr(String(err.message || err)))}</p>`
      retryBtn.classList.remove('hidden')

      updateNav()
    })
}

// ═══════════════════════════════════════════════
// 步骤 4：预览
// ═══════════════════════════════════════════════

function renderPreview() {
  const statsEl = $('llmPreviewStats')
  const ambigEl = $('llmAmbiguityWarning')
  const droppedEl = $('llmDroppedHint')
  const tbody = $('llmPreviewTbody')

  // 区域分布统计
  const stats = LlmUtils.areaStats(state.points)
  const areaLabels = { holding: '保持寄存器', input: '输入寄存器', coil: '线圈', discrete: '离散输入' }
  const areaParts = []
  for (const a of LlmUtils.AREAS) {
    if (stats[a] > 0) areaParts.push(`${areaLabels[a]} ${stats[a]}`)
  }

  statsEl.innerHTML = `
    <div class="llm-stats-header">
      <span class="llm-stats-total">共 <strong>${stats.total}</strong> 个点位</span>
      <span class="hint">${areaParts.join(' / ')}</span>
    </div>`

  // 地址歧义警告
  const ambiguity = state.stats?.addrAmbiguityWarning
  if (ambiguity) {
    ambigEl.classList.remove('hidden')
    ambigEl.innerHTML = `&#9888; 地址歧义提醒：${escapeHtml(String(ambiguity))}`
  } else {
    ambigEl.classList.add('hidden')
  }

  // 非法点位丢弃提示
  const droppedInvalid = state.stats?.droppedInvalid
  if (typeof droppedInvalid === 'number' && droppedInvalid > 0) {
    droppedEl.classList.remove('hidden')
    droppedEl.innerHTML = `提示：解析过程中有 ${droppedInvalid} 个点位因格式异常被自动丢弃`
  } else {
    droppedEl.classList.add('hidden')
  }

  // 渲染点位表
  if (!state.points.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--ink-3)">暂无点位</td></tr>'
  } else {
    tbody.innerHTML = state.points.map(p => {
      const areaLabel = areaLabels[p.area] || p.area
      const typeLabel = (Codec.TYPES && Codec.TYPES[p.type]?.label) || p.type
      const addrHex = '0x' + (Number(p.addr) || 0).toString(16).toUpperCase()
      return `<tr>
        <td>${escapeHtml(p.name || '')}</td>
        <td>${areaLabel}</td>
        <td class="mono">${p.addr} (${addrHex})</td>
        <td>${typeLabel}</td>
        <td>${p.k !== undefined && p.k !== 1 ? p.k : '—'}</td>
        <td>${p.b !== undefined && p.b !== 0 ? p.b : '—'}</td>
        <td>${escapeHtml(p.unit || '')}</td>
      </tr>`
    }).join('')
  }
}

// ═══════════════════════════════════════════════
// 保存为新类型
// ═══════════════════════════════════════════════

async function onSaveAsNewType() {
  // 校验点位
  const result = Codec.validatePoints(state.points)
  if (!result.ok) {
    showStepError(4, `点位校验失败：${result.error}`)
    return
  }

  // 获取已有类型名去重
  const existingNames = (DeviceUI.state && DeviceUI.state.types)
    ? DeviceUI.state.types.map(t => t.name)
    : []

  // 生成默认名称：用文件名（去扩展名）
  const baseFileName = state.fileName
    ? state.fileName.replace(/\.[^.]+$/, '')
    : ''

  // 使用 LlmUtils.generateDefaultTypeName，但优先用文件名
  let typeName
  if (baseFileName) {
    typeName = deduplicateName(baseFileName, existingNames)
  } else {
    typeName = LlmUtils.generateDefaultTypeName(existingNames)
  }

  // 创建新类型对象
  const newType = {
    id: genTypeId(),
    name: typeName,
    points: result.points,
  }

  // 添加到 DeviceUI.state.types
  if (!DeviceUI.state) {
    showStepError(4, '设备类型状态未初始化，请刷新页面后重试')
    return
  }
  DeviceUI.state.types.push(newType)

  // 落库
  try {
    const cfg = await window.api.loadConfig()
    await window.api.saveConfig({
      ...cfg,
      deviceTypes: DeviceUI.state.types,
      deviceInstances: DeviceUI.state.instances || [],
    })
  } catch (err) {
    // 回滚
    DeviceUI.state.types.pop()
    showStepError(4, `保存失败：${cleanErr(String(err.message || err))}`)
    return
  }

  // 关闭向导，刷新页面
  closeModal(false)
  // 触发管理页刷新
  try { if (typeof DeviceUI.renderMgrPage === 'function') DeviceUI.renderMgrPage() } catch { /* ignore */ }
}

function genTypeId() {
  // 与 device.js 的 genId 逻辑对齐：dev{N}
  const existing = (DeviceUI.state && DeviceUI.state.types) ? DeviceUI.state.types : []
  let maxN = 0
  existing.forEach(t => {
    const m = String(t.id).match(/^dev(\d+)$/)
    if (m) {
      const n = parseInt(m[1], 10)
      if (n > maxN) maxN = n
    }
  })
  return `dev${maxN + 1}`
}

function deduplicateName(base, existingNames) {
  const set = new Set((existingNames || []).map(n => String(n).trim()))
  if (!set.has(base)) return base
  let i = 2
  while (set.has(`${base} (${i})`)) i++
  return `${base} (${i})`
}

// ═══════════════════════════════════════════════
// 事件绑定
// ═══════════════════════════════════════════════

function init() {
  // 打开向导
  const mgrBtn = $('mgrLlmWizardBtn')
  if (mgrBtn) mgrBtn.addEventListener('click', openModal)

  // 关闭
  const closeBtn = $('llmWizardClose')
  if (closeBtn) closeBtn.addEventListener('click', () => closeModal(true))

  const cancelBtn = $('llmCancelBtn')
  if (cancelBtn) cancelBtn.addEventListener('click', () => closeModal(true))

  // 上传区域
  const uploadArea = $('llmUploadArea')
  const fileInput = $('llmFileInput')

  if (uploadArea && fileInput) {
    uploadArea.addEventListener('click', () => fileInput.click())

    // 拖拽
    uploadArea.addEventListener('dragover', e => {
      e.preventDefault()
      e.stopPropagation()
      uploadArea.classList.add('drag-over')
    })
    uploadArea.addEventListener('dragleave', e => {
      e.preventDefault()
      e.stopPropagation()
      uploadArea.classList.remove('drag-over')
    })
    uploadArea.addEventListener('drop', e => {
      e.preventDefault()
      e.stopPropagation()
      uploadArea.classList.remove('drag-over')
      const file = e.dataTransfer?.files?.[0]
      if (file) onFileSelected(file)
    })
  }

  if (fileInput) {
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0]
      if (file) onFileSelected(file)
      // 重置以便同一文件可以再次选择
      fileInput.value = ''
    })
  }

  // 重新选择文件
  const reselectBtn = $('llmFileReselect')
  if (reselectBtn) {
    reselectBtn.addEventListener('click', () => {
      state.docId = null
      state.fileName = null
      state.charCount = 0
      const uploadAreaEl = $('llmUploadArea')
      const filePreviewEl = $('llmFilePreview')
      if (uploadAreaEl) {
        uploadAreaEl.classList.remove('disabled')
        uploadAreaEl.style.pointerEvents = ''
      }
      if (filePreviewEl) filePreviewEl.classList.add('hidden')
      clearStepError(1)
      updateNav()
    })
  }

  // Key 显示/隐藏切换
  const toggleKeyBtn = $('llmToggleKey')
  if (toggleKeyBtn) {
    toggleKeyBtn.addEventListener('click', () => {
      const input = $('llmApiKey')
      if (!input) return
      const isPassword = input.type === 'password'
      input.type = isPassword ? 'text' : 'password'
      toggleKeyBtn.textContent = isPassword ? '\u{1F648}' : '\u{1F440}'
    })
  }

  // 测试连接：用表单当前值直接测（未保存也能测），结果就地显示
  const testBtn = $('llmTestBtn')
  if (testBtn) testBtn.addEventListener('click', onTestConnection)

  // 下一步按钮
  const nextBtn = $('llmNextBtn')
  if (nextBtn) {
    nextBtn.addEventListener('click', () => {
      if (state.inProgress) return

      switch (state.step) {
        case 1:
          // 步骤 1 → 2：检查是否已选文件
          if (!state.docId) {
            showStepError(1, '请先选择并上传文件')
            return
          }
          goToStep(2)
          break

        case 2:
          // 步骤 2 → 3：保存设置（localStorage），进解析
          clearStepError(2)
          saveSettingsToLocal()
          goToStep(3)
          break

        case 3:
          // 步骤 3：如果已有结果则进步骤 4，否则开始解析
          if (Array.isArray(state.points) && state.points.length > 0) {
            goToStep(4)
            renderPreview()
          } else {
            onParse()
          }
          break

        case 4:
          // 步骤 4：保存为新类型
          onSaveAsNewType()
          break
      }
    })
  }

  // 上一步按钮
  const backBtn = $('llmBackBtn')
  if (backBtn) {
    backBtn.addEventListener('click', () => {
      if (state.inProgress) return
      const prev = LlmWizardState.prevStep(state.step)
      if (prev !== null) {
        clearStepError(state.step)
        goToStep(prev)
      }
    })
  }

  // 重试按钮
  const retryBtn = $('llmRetryBtn')
  if (retryBtn) {
    retryBtn.addEventListener('click', () => {
      if (state.inProgress) return
      // 重置解析界面
      const parseIdle = $('llmParseIdle')
      const parseError = $('llmParseError')
      if (parseIdle) {
        parseIdle.classList.remove('hidden')
        parseIdle.innerHTML = '<p>点击「开始解析」提取文档中的 Modbus 点位信息</p>'
      }
      if (parseError) parseError.classList.add('hidden')
      retryBtn.classList.add('hidden')
      onParse()
    })
  }

  // 点击遮罩层关闭
  $('llmWizardModal')?.addEventListener('click', e => {
    if (e.target === $('llmWizardModal')) {
      closeModal(true)
    }
  })

  // ESC 关闭
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      const modal = $('llmWizardModal')
      if (modal && !modal.classList.contains('hidden')) {
        closeModal(true)
      }
    }
  })
}

// ═══════════════════════════════════════════════
return { init }
})()

if (typeof window !== 'undefined') window.LlmWizardUI = LlmWizardUI
if (typeof module !== 'undefined') module.exports = LlmWizardUI
