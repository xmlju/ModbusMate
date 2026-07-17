// main/llm/llm-service.js — LLM 点表生成的运行时服务
// 职责：文档文本抽取（含网页模式 base64 上传）、缓存全文、驱动分段抽取并转发进度事件
// 依赖全部可注入，方便单测 mock；LLM 配置从 config.json 的 llm 字段读取

const { EventEmitter } = require('events')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { extractFromFile } = require('./text-extractor')
const { createProvider } = require('./provider')
const { extractPoints } = require('./point-extractor')

/** 网页模式上传文件的解码后大小上限（实测 .doc 手册可达 13 MB） */
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024

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
    this._doc = null        // 最近一次抽取的文档：{ docId, text, fileName, charCount, preview, format }
    this._running = false   // 同一时间只允许一个 LLM 抽取任务
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
      let buffer
      try {
        buffer = Buffer.from(dataBase64, 'base64')
      } catch (cause) {
        throw new Error('上传的文件内容不是有效的 base64 编码', { cause })
      }
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
      return {
        docId,
        fileName: displayName,
        charCount: result.charCount,
        preview: result.preview,
        format: result.format,
      }
    } finally {
      if (cleanupPath) {
        try { fs.unlinkSync(cleanupPath) } catch { /* 临时文件清理失败不影响主流程 */ }
      }
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

      return await this._extractPoints({
        text: this._doc.text,
        provider,
        onProgress: progress => this.emit('progress', { docId, ...progress }),
      })
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

module.exports = { createLlmService, LlmService, MAX_UPLOAD_BYTES, ALLOWED_EXTENSIONS }
