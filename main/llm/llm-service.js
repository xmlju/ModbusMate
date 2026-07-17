// main/llm/llm-service.js — LLM 点表生成的运行时服务
// 职责：文档文本抽取（含网页模式 base64 上传）、缓存全文、驱动分段抽取并转发进度事件
// 依赖全部可注入，方便单测 mock；LLM 配置从 config.json 的 llm 字段读取

const { EventEmitter } = require('events')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { extractFromFile } = require('./text-extractor')
const { createProvider, DEFAULT_MODEL } = require('./provider')
const { extractPoints } = require('./point-extractor')

/** 网页模式上传文件的解码后大小上限（实测 .doc 手册可达 13 MB） */
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024

/** 普通用户 LLM 解析试用次数上限（高级会员不限；只有解析成功才计数） */
const TRIAL_LIMIT = 3

/** 允许上传的文档扩展名 */
const ALLOWED_EXTENSIONS = Object.freeze(['.pdf', '.docx', '.doc', '.txt'])

class LlmService extends EventEmitter {
  constructor(options = {}) {
    super()
    if (typeof options.loadConfig !== 'function') {
      throw new TypeError('LLM 服务配置错误：loadConfig 必须是函数')
    }
    this._loadConfig = options.loadConfig
    this._extractFromFile = options.extractFromFile ?? extractFromFile
    this._createProvider = options.createProvider ?? createProvider
    this._extractPoints = options.extractPoints ?? extractPoints
    this._tmpDir = options.tmpDir ?? os.tmpdir()
    // 试用计数文件路径。未注入时不限次（单测/嵌入场景）；生产两端都会注入
    this._usageFile = options.usageFile ?? null
    this._doc = null        // 最近一次抽取的文档：{ docId, text, fileName, charCount, preview, format }
    this._running = false   // 同一时间只允许一个 LLM 抽取任务
  }

  /** 读取已用试用次数（文件缺失/损坏一律按 0 处理，不阻塞用户） */
  _readUsage() {
    if (!this._usageFile) return { used: 0 }
    try {
      const raw = JSON.parse(fs.readFileSync(this._usageFile, 'utf8'))
      const used = Number(raw?.used)
      return { used: Number.isFinite(used) && used > 0 ? Math.floor(used) : 0 }
    } catch {
      return { used: 0 }
    }
  }

  /** 解析成功后累加计数（写失败不影响返回结果，只是下次少算一次） */
  _bumpUsage() {
    if (!this._usageFile) return
    try {
      const { used } = this._readUsage()
      fs.writeFileSync(this._usageFile, JSON.stringify({
        used: used + 1,
        lastUsedAt: new Date().toISOString(),
      }))
    } catch { /* 计数写盘失败不阻塞主流程 */ }
  }

  /** 会员判定：预留 config.license.plan === 'premium'（V2 接正式会员体系时替换） */
  _isPremium(config) {
    return config?.license?.plan === 'premium'
  }

  /** 当前配额信息，供前端展示 */
  _quota(config) {
    // premium 的 remaining 用 null 表示不限（Infinity 过 JSON 桥会变 null，干脆显式）
    if (this._isPremium(config)) return { premium: true, used: 0, limit: TRIAL_LIMIT, remaining: null }
    if (!this._usageFile) return { premium: false, used: 0, limit: TRIAL_LIMIT, remaining: TRIAL_LIMIT }
    const { used } = this._readUsage()
    return { premium: false, used, limit: TRIAL_LIMIT, remaining: Math.max(0, TRIAL_LIMIT - used) }
  }

  /**
   * 抽取文档文本。两种入参：
   * - { filePath }：Electron 模式，主进程直接读本地文件
   * - { fileName, dataBase64 }：网页模式，浏览器上传文件内容
   * 返回文档元信息（不含全文，全文缓存在服务内，凭 docId 引用）
   */
  async extractText(params) {
    const { filePath, fileName, dataBase64 } = params || {}

    let targetPath
    let cleanupPath = null
    let displayName

    if (typeof filePath === 'string' && filePath.trim()) {
      targetPath = filePath
      displayName = path.basename(filePath)
    } else if (typeof dataBase64 === 'string' && dataBase64.trim()) {
      displayName = sanitizeFileName(fileName)
      const ext = path.extname(displayName).toLowerCase()
      if (!ALLOWED_EXTENSIONS.includes(ext)) {
        throw new Error(`不支持的文件格式: ${ext || '(无扩展名)'}，仅支持 ${ALLOWED_EXTENSIONS.join('/')}`)
      }
      // Node 的 base64 解码会静默忽略非法字符（如 "[object ArrayBuffer]" 也能解出乱字节），
      // 必须先显式校验字符集，否则前端传错类型时报错会误导为"文件格式不支持"
      const compact = dataBase64.replace(/\s/g, '')
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
        throw new Error('上传的文件内容不是有效的 base64 编码（前端传参类型错误？）')
      }
      const buffer = Buffer.from(compact, 'base64')
      if (buffer.length === 0) throw new Error('上传的文件内容为空')
      if (buffer.length > MAX_UPLOAD_BYTES) {
        throw new Error(`上传文件超过 ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)} MiB 上限，请压缩或拆分文档`)
      }
      targetPath = path.join(this._tmpDir, `modbusmate-llm-${crypto.randomUUID()}${ext}`)
      fs.writeFileSync(targetPath, buffer)
      cleanupPath = targetPath
    } else {
      throw new Error('缺少必要参数：需要 filePath（本机路径）或 fileName + dataBase64（上传内容）')
    }

    try {
      const result = await this._extractFromFile(targetPath)
      const docId = crypto.randomUUID()
      this._doc = {
        docId,
        text: result.text,
        fileName: displayName,
        charCount: result.charCount,
        preview: result.preview,
        format: result.format,
      }
      // 附带配额信息，前端在向导里展示"试用剩余 N 次"
      let quota
      try { quota = this._quota(await this._loadConfig()) } catch { quota = this._quota(null) }
      return {
        docId,
        fileName: displayName,
        charCount: result.charCount,
        preview: result.preview,
        format: result.format,
        quota,
      }
    } finally {
      if (cleanupPath) {
        try { fs.unlinkSync(cleanupPath) } catch { /* 临时文件清理失败不影响主流程 */ }
      }
    }
  }

  /**
   * 测试 LLM 连接：发一条最小请求验证 baseURL / API Key / 模型名是否可用。
   * 参数里给了就用参数（设置表单未保存也能先测），缺省项回落到已存配置
   * @param {{ baseURL?: string, apiKey?: string, model?: string }} [params]
   * @returns {Promise<{ ok: true, model: string, latencyMs: number, totalTokens: number }>}
   */
  async testConnection(params) {
    const stored = (await this._loadConfig())?.llm || {}
    const given = params || {}
    const baseURL = String(given.baseURL || stored.baseURL || '').trim()
    const apiKey = String(given.apiKey || stored.apiKey || '').trim()
    const model = String(given.model || stored.model || '').trim()

    if (!baseURL) throw new Error('请先填写 baseURL（如 https://api.deepseek.com）')
    if (!apiKey) throw new Error('请先填写 API Key')

    // 测试用较短超时，避免用户在设置页干等一分钟
    const provider = this._createProvider({ baseURL, apiKey, model, timeoutMs: 15000 })
    const started = Date.now()
    const result = await provider.chatCompletion({
      messages: [{ role: 'user', content: '连通性测试，请只回复：OK' }],
      temperature: 0,
    })
    return {
      ok: true,
      model: model || DEFAULT_MODEL,
      latencyMs: Date.now() - started,
      totalTokens: result.usage.totalTokens,
    }
  }

  /**
   * 用缓存文档启动 LLM 分段抽取。进度经 'progress' 事件推送
   * @param {{ docId: string }} params
   */
  async extractPoints(params) {
    const { docId } = params || {}
    if (!this._doc || this._doc.docId !== docId) {
      throw new Error('文档缓存不存在或已过期，请重新选择文件抽取文本')
    }
    if (this._running) {
      throw new Error('已有一个 LLM 解析任务在进行中，请等待其完成')
    }
    // 锁必须在首个 await 之前置位，否则两个快速连续调用都能穿过上面的守卫
    this._running = true

    try {
      const config = await this._loadConfig()

      // 试用限制：普通用户 3 次（只有解析成功才计数），高级会员不限
      const quota = this._quota(config)
      if (!quota.premium && quota.remaining <= 0) {
        throw new Error(`试用次数已用完（${quota.used}/${quota.limit}）：AI 生成点表为高级会员功能，请联系作者开通后继续使用`)
      }

      const llm = config?.llm
      if (!llm || typeof llm !== 'object') {
        throw new Error('尚未配置 LLM 服务，请先在设置中填写 API Key、baseURL 和模型')
      }
      if (!llm.baseURL) throw new Error('LLM 配置缺少 baseURL，请在设置中填写（如 https://api.deepseek.com）')
      if (!llm.apiKey) throw new Error('LLM 配置缺少 API Key，请在设置中填写')

      const provider = this._createProvider({
        baseURL: llm.baseURL,
        apiKey: llm.apiKey,
        model: llm.model,
        timeoutMs: llm.timeoutMs,
      })

      const result = await this._extractPoints({
        text: this._doc.text,
        provider,
        onProgress: progress => this.emit('progress', { docId, ...progress }),
      })
      // 解析成功才消耗一次试用（失败/中断不计，不冤枉用户）
      if (!quota.premium) this._bumpUsage()
      return result
    } finally {
      this._running = false
    }
  }
}

/** 去掉路径分隔符与控制字符，只保留安全文件名 */
function sanitizeFileName(value) {
  const leaf = String(value || '').split(/[\\/]/).at(-1)
  return leaf.replace(/[\u0000-\u001f\u007f]/g, "_").trim() || 'document'
}

function createLlmService(options) {
  return new LlmService(options)
}

module.exports = { createLlmService, LlmService, MAX_UPLOAD_BYTES, ALLOWED_EXTENSIONS, TRIAL_LIMIT }
