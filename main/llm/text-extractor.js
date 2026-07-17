// main/llm/text-extractor.js — 从 PDF/DOCX/DOC/TXT 文档中提取纯文本
// 全部在 main 进程执行，零 token 消耗
// 设计成依赖可注入，方便单测 mock

const fs = require('fs')
const path = require('path')

/** 最少需要抽取的字符数，低于此值视为扫描件 */
const MIN_CHAR_COUNT = 200

/**
 * 提取文件扩展名（小写）
 */
function extname(filePath) {
  return path.extname(filePath).toLowerCase()
}

/**
 * 从 TXT 文件直接读取文本
 */
function extractText(filePath) {
  const text = fs.readFileSync(filePath, 'utf-8')
  if (text.length < MIN_CHAR_COUNT) {
    throw new Error('文档无法抽取文本（可能是扫描件），请转换为文字版')
  }
  return text
}

/**
 * 创建 PDF 抽取函数（依赖注入 pdf-parse）
 * @param {function} pdfParse - pdf-parse 模块
 */
function createPdfExtractor(pdfParse) {
  return async function extractPdf(filePath) {
    const dataBuffer = fs.readFileSync(filePath)
    const data = await pdfParse(dataBuffer)
    const text = data.text
    if (!text || text.trim().length < MIN_CHAR_COUNT) {
      throw new Error('文档无法抽取文本（可能是扫描件），请转换为文字版')
    }
    return text
  }
}

/**
 * 创建 DOCX 抽取函数（依赖注入 mammoth）
 * @param {object} mammoth - mammoth 模块
 */
function createDocxExtractor(mammoth) {
  return async function extractDocx(filePath) {
    const result = await mammoth.extractRawText({ path: filePath })
    const text = result.value
    if (!text || text.trim().length < MIN_CHAR_COUNT) {
      throw new Error('文档无法抽取文本（可能是扫描件），请转换为文字版')
    }
    return text
  }
}

/**
 * 创建 DOC 抽取函数（依赖注入 word-extractor）
 * @param {function} WordExtractor - word-extractor 构造函数
 */
function createDocExtractor(WordExtractor) {
  return async function extractDoc(filePath) {
    const extractor = new WordExtractor()
    const doc = await extractor.extract(filePath)
    const text = doc.getBody()
    if (!text || text.trim().length < MIN_CHAR_COUNT) {
      throw new Error('文档无法抽取文本（可能是扫描件），请转换为文字版')
    }
    return text
  }
}

/**
 * 生产环境用的默认提取器实例（延迟加载，零 token 消耗）
 */
let _defaultPdf, _defaultDocx, _defaultDoc
function getExtractors() {
  if (!_defaultPdf) {
    // pdf-parse v2 是类接口（v1 的函数式调用已废弃），这里包一层适配成
    // createPdfExtractor 期望的 `async (buffer) => { text }` 形态
    const { PDFParse } = require('pdf-parse')
    const pdfParse = async dataBuffer => {
      const parser = new PDFParse({ data: new Uint8Array(dataBuffer) })
      try {
        return await parser.getText()   // { text, ... }
      } finally {
        try { await parser.destroy?.() } catch { /* 释放失败不影响结果 */ }
      }
    }
    _defaultPdf = createPdfExtractor(pdfParse)
    _defaultDocx = createDocxExtractor(require('mammoth'))
    _defaultDoc = createDocExtractor(require('word-extractor'))
  }
  return { extractPdf: _defaultPdf, extractDocx: _defaultDocx, extractDoc: _defaultDoc }
}

/**
 * 从文件路径抽取文本，自动识别格式
 * @param {string} filePath - 文档文件绝对路径
 * @returns {Promise<{text: string, charCount: number, preview: string, format: string}>}
 */
async function extractFromFile(filePath) {
  const ext = extname(filePath)
  let text

  switch (ext) {
    case '.pdf':
      text = await getExtractors().extractPdf(filePath)
      break
    case '.docx':
      text = await getExtractors().extractDocx(filePath)
      break
    case '.doc':
      text = await getExtractors().extractDoc(filePath)
      break
    case '.txt':
      text = await extractText(filePath)
      break
    default:
      throw new Error(`不支持的文件格式: ${ext}`)
  }

  const cleaned = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()
  const charCount = cleaned.length

  if (charCount < MIN_CHAR_COUNT) {
    throw new Error('文档无法抽取文本（可能是扫描件），请转换为文字版')
  }

  const preview = cleaned.slice(0, 500)

  return {
    text: cleaned,
    charCount,
    preview,
    format: ext.slice(1),
  }
}

module.exports = {
  extractFromFile,
  extractText,
  createPdfExtractor,
  createDocxExtractor,
  createDocExtractor,
  getExtractors,
  MIN_CHAR_COUNT,
}
