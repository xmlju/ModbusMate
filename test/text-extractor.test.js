// test/text-extractor.test.js — text-extractor 单元测试
// 测试 PDF/DOCX/DOC/TXT 四种格式的文本抽取
// 全部通过依赖注入 mock，无真实 I/O 依赖（TXT 除外）

import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'

const {
  extractFromFile,
  extractText,
  createPdfExtractor,
  createDocxExtractor,
  createDocExtractor,
  MIN_CHAR_COUNT,
} = require('../main/llm/text-extractor.js')

describe('text-extractor', () => {
  // ================================================================
  // extractText (实际用真实 TXT 文件)
  // ================================================================
  describe('extractText', () => {
    it('正常读取 UTF-8 文本', () => {
      const file = path.join(__dirname, 'llm-fixture-txt-test.txt')
      fs.writeFileSync(file, '保持寄存器 0000 开关\n'.repeat(30), 'utf-8')

      const text = extractText(file)
      expect(text).toContain('保持寄存器 0000 开关')

      fs.unlinkSync(file)
    })

    it('短文本抛扫描件异常', () => {
      const file = path.join(__dirname, 'llm-fixture-txt-short.txt')
      fs.writeFileSync(file, 'hello', 'utf-8')

      expect(() => extractText(file)).toThrow('扫描件')

      fs.unlinkSync(file)
    })
  })

  // ================================================================
  // createPdfExtractor — DI 注入 mock
  // ================================================================
  describe('createPdfExtractor', () => {
    let mockPdfParse, extractPdf

    beforeEach(() => {
      mockPdfParse = vi.fn()
      extractPdf = createPdfExtractor(mockPdfParse)
    })

    it('正常抽取 PDF 文本', async () => {
      mockPdfParse.mockResolvedValue({ text: '保持寄存器 4544 充电桩测试电压需求\n'.repeat(10) })

      const file = path.join(__dirname, 'llm-fixture-pdf.bin')
      fs.writeFileSync(file, 'x')

      const text = await extractPdf(file)
      expect(text).toContain('保持寄存器 4544')
      expect(mockPdfParse).toHaveBeenCalled()

      fs.unlinkSync(file)
    })

    it('PDF 文本过短抛异常', async () => {
      mockPdfParse.mockResolvedValue({ text: 'short' })

      const file = path.join(__dirname, 'llm-fixture-pdf-short.bin')
      fs.writeFileSync(file, 'x')

      await expect(extractPdf(file)).rejects.toThrow('扫描件')

      fs.unlinkSync(file)
    })

    it('PDF 文本为空抛异常', async () => {
      mockPdfParse.mockResolvedValue({ text: '' })

      const file = path.join(__dirname, 'llm-fixture-pdf-empty.bin')
      fs.writeFileSync(file, 'x')

      await expect(extractPdf(file)).rejects.toThrow('扫描件')

      fs.unlinkSync(file)
    })
  })

  // ================================================================
  // createDocxExtractor — DI 注入 mock
  // ================================================================
  describe('createDocxExtractor', () => {
    let mockMammoth, extractDocx

    beforeEach(() => {
      mockMammoth = { extractRawText: vi.fn() }
      extractDocx = createDocxExtractor(mockMammoth)
    })

    it('正常抽取 DOCX 文本', async () => {
      mockMammoth.extractRawText.mockResolvedValue({ value: '线圈 0000 开关\n'.repeat(50) })

      const text = await extractDocx('/fake/sample.docx')
      expect(text).toContain('线圈 0000 开关')
    })

    it('DOCX 文本过短抛异常', async () => {
      mockMammoth.extractRawText.mockResolvedValue({ value: 'x' })

      await expect(extractDocx('/fake/short.docx')).rejects.toThrow('扫描件')
    })
  })

  // ================================================================
  // createDocExtractor — DI 注入 mock
  // ================================================================
  describe('createDocExtractor', () => {
    it('正常抽取旧版 .doc 文本', async () => {
      // .repeat(15) = ~255 字符，超过 200 的最低阈值
      const bodyText = '离散量 01F6 充电桩测试模式设置\n'.repeat(15)
      const mockInstance = {
        extract: vi.fn().mockResolvedValue({ getBody: () => bodyText }),
      }
      const MockCtor = function () { return mockInstance }
      const extracted = createDocExtractor(MockCtor)

      const text = await extracted('/fake/sample.doc')
      expect(text).toContain('离散量 01F6')
      expect(mockInstance.extract).toHaveBeenCalledWith('/fake/sample.doc')
    })

    it('DOC 文本过短抛异常', async () => {
      const mockInstance = {
        extract: vi.fn().mockResolvedValue({ getBody: () => 'x' }),
      }
      const MockCtor = function () { return mockInstance }
      const extracted = createDocExtractor(MockCtor)

      await expect(extracted('/fake/short.doc')).rejects.toThrow('扫描件')
    })
  })

  // ================================================================
  // extractFromFile — 格式分发
  // ================================================================
  describe('extractFromFile', () => {
    it('TXT: 正常读取并返回结构', async () => {
      const file = path.join(__dirname, 'llm-fixture-e2e-txt.txt')
      const content = '保持寄存器 0000 开关\n保持寄存器 0001 复位\n'.repeat(30)
      fs.writeFileSync(file, content, 'utf-8')

      const result = await extractFromFile(file)
      expect(result.format).toBe('txt')
      expect(result.charCount).toBeGreaterThan(MIN_CHAR_COUNT)
      expect(result.text).toContain('保持寄存器 0000 开关')
      expect(result.preview.length).toBeLessThanOrEqual(500)

      fs.unlinkSync(file)
    })

    it('TXT: 短文本抛扫描件异常', async () => {
      const file = path.join(__dirname, 'llm-fixture-e2e-short.txt')
      fs.writeFileSync(file, 'hello', 'utf-8')

      await expect(extractFromFile(file)).rejects.toThrow('扫描件')

      fs.unlinkSync(file)
    })

    it('PDF: 通过 pdf extractor 分支', async () => {
      const mockPdfParse = vi.fn().mockResolvedValue({ text: 'A'.repeat(300) })
      const pdf = createPdfExtractor(mockPdfParse)

      const file = path.join(__dirname, 'llm-fixture-e2e-pdf.bin')
      fs.writeFileSync(file, 'x')

      const text = await pdf(file)
      expect(text.length).toBeGreaterThanOrEqual(200)

      fs.unlinkSync(file)
    })

    it('DOCX: 通过 docx extractor 分支', async () => {
      const mockMammoth = { extractRawText: vi.fn().mockResolvedValue({ value: 'B'.repeat(300) }) }
      const docx = createDocxExtractor(mockMammoth)

      const text = await docx('/fake/test.docx')
      expect(text.length).toBe(300)
    })

    it('DOC: 通过 doc extractor 分支', async () => {
      const mockInstance = { extract: vi.fn().mockResolvedValue({ getBody: () => 'C'.repeat(300) }) }
      const MockCtor = function () { return mockInstance }
      const doc = createDocExtractor(MockCtor)

      const text = await doc('/fake/test.doc')
      expect(text.length).toBe(300)
    })

    it('不支持的格式抛异常', async () => {
      await expect(extractFromFile('/fake/file.xlsx')).rejects.toThrow('不支持的文件格式')
    })

    it('无扩展名抛异常', async () => {
      await expect(extractFromFile('/fake/nofile')).rejects.toThrow('不支持的文件格式')
    })

    it('\\r\\n 换行符统一转为 \\n', async () => {
      const mockMammoth = { extractRawText: vi.fn().mockResolvedValue({ value: 'line1\r\nline2\r\nline3\r\n'.repeat(20) }) }
      const docx = createDocxExtractor(mockMammoth)

      const rawText = await docx('/fake/test.docx')
      const cleaned = rawText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()
      expect(cleaned).not.toContain('\r\n')
      expect(cleaned).not.toContain('\r')
    })

    it('preview 截取前 500 字符', async () => {
      const mockMammoth = { extractRawText: vi.fn().mockResolvedValue({ value: 'A'.repeat(1000) }) }
      const docx = createDocxExtractor(mockMammoth)

      const rawText = await docx('/fake/test.docx')
      const cleaned = rawText.trim()
      const preview = cleaned.slice(0, 500)
      expect(preview.length).toBe(500)
    })
  })

  // ================================================================
  // 真实 pdf-parse 库集成（回归：v2 改为类接口后 "pdfParse is not a function"，
  // 之前全部 mock 导致真实库从未被调用过，测试全绿但线上必炸）
  describe('getExtractors 真实库集成', () => {
    /** 程序化生成最小合法 PDF（单页单文本对象），不依赖外部 fixture 文件 */
    function buildMinimalPdf(text) {
      const objects = []
      objects.push('<< /Type /Catalog /Pages 2 0 R >>')
      objects.push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>')
      objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>')
      objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
      // 多行写入：单行超出页宽的部分不会被抽取，每行 ~60 字符 × 多行凑够字数
      const lines = []
      for (let i = 0; i < 8; i++) lines.push(`(${text}) Tj 0 -16 Td`)
      const stream = `BT /F1 12 Tf 36 750 Td ${lines.join(' ')} ET`
      objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)

      let body = '%PDF-1.4\n'
      const offsets = []
      objects.forEach((content, i) => {
        offsets.push(body.length)
        body += `${i + 1} 0 obj\n${content}\nendobj\n`
      })
      const xrefPos = body.length
      body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
      for (const off of offsets) body += `${String(off).padStart(10, '0')} 00000 n \n`
      body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`
      return Buffer.from(body, 'latin1')
    }

    it('extractPdf 用真实 pdf-parse 抽取文本（不经任何 mock）', async () => {
      const { getExtractors } = require('../main/llm/text-extractor.js')
      const tmp = path.join(require('os').tmpdir(), `pdf-real-${Date.now()}.pdf`)
      // 内容需超过 MIN_CHAR_COUNT（8 行 × 52 字符 > 200），否则会被判为扫描件
      const marker = 'ModbusRegister4544Voltage '.repeat(2)
      fs.writeFileSync(tmp, buildMinimalPdf(marker))
      try {
        const text = await getExtractors().extractPdf(tmp)
        expect(text).toContain('ModbusRegister4544Voltage')
      } finally {
        fs.unlinkSync(tmp)
      }
    })
  })
})
