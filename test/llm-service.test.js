import { describe, it, expect, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const { createLlmService, MAX_UPLOAD_BYTES } = require('../main/llm/llm-service')

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function createFixture(overrides = {}) {
  const extractFromFile = vi.fn(async () => ({
    text: '寄存器 0000 电压'.repeat(30),
    charCount: 300,
    preview: '寄存器 0000 电压',
    format: 'txt',
  }))
  const provider = { chatCompletion: vi.fn() }
  const createProvider = vi.fn(() => provider)
  const extractPoints = vi.fn(async ({ onProgress }) => {
    onProgress?.({ segment: 1, totalSegments: 2, accumulatedPoints: 3, accumulatedTokens: 120 })
    return {
      points: [{ name: '电压', area: 'holding', addr: 0 }],
      stats: { totalSegments: 2, totalTokens: 240, droppedInvalid: 0, addrAmbiguityWarning: null },
    }
  })
  const loadConfig = vi.fn(() => ({
    llm: { baseURL: 'https://api.deepseek.com', apiKey: 'sk-test', model: 'deepseek-chat' },
  }))
  const service = createLlmService({
    loadConfig,
    extractFromFile,
    createProvider,
    extractPoints,
    tmpDir: os.tmpdir(),
    ...overrides,
  })
  return { service, extractFromFile, createProvider, extractPoints, loadConfig, provider }
}

describe('LLM 点表生成服务', () => {
  it('缺少 loadConfig 时拒绝创建', () => {
    expect(() => createLlmService({})).toThrow('loadConfig 必须是函数')
  })

  describe('extractText — filePath 模式', () => {
    it('返回文档元信息且不外泄全文', async () => {
      const { service, extractFromFile } = createFixture()

      const result = await service.extractText({ filePath: '/docs/手册.pdf' })

      expect(extractFromFile).toHaveBeenCalledWith('/docs/手册.pdf')
      expect(result).toEqual({
        docId: expect.any(String),
        fileName: '手册.pdf',
        charCount: 300,
        preview: '寄存器 0000 电压',
        format: 'txt',
      })
      expect(result.text).toBeUndefined()
    })

    it('抽取失败时透传中文错误', async () => {
      const { service } = createFixture({
        extractFromFile: vi.fn(async () => { throw new Error('文档无法抽取文本（可能是扫描件），请转换为文字版') }),
      })

      await expect(service.extractText({ filePath: '/docs/扫描件.pdf' }))
        .rejects.toThrow('可能是扫描件')
    })
  })

  describe('extractText — base64 上传模式', () => {
    it('落临时文件抽取并在完成后清理', async () => {
      const { service, extractFromFile } = createFixture()
      const payload = Buffer.from('寄存器手册内容').toString('base64')

      const result = await service.extractText({ fileName: 'C:\\upload\\说明书.doc', dataBase64: payload })

      expect(result.fileName).toBe('说明书.doc')  // 路径前缀被剥离
      const tempPath = extractFromFile.mock.calls[0][0]
      expect(tempPath).toMatch(/modbusmate-llm-.*\.doc$/)
      expect(fs.existsSync(tempPath)).toBe(false)  // 临时文件已删除
    })

    it('抽取失败时同样清理临时文件', async () => {
      const extractFromFile = vi.fn(async () => { throw new Error('解析失败') })
      const { service } = createFixture({ extractFromFile })

      await expect(service.extractText({ fileName: 'a.txt', dataBase64: Buffer.from('x').toString('base64') }))
        .rejects.toThrow('解析失败')
      expect(fs.existsSync(extractFromFile.mock.calls[0][0])).toBe(false)
    })

    it('拒绝不支持的扩展名', async () => {
      const { service } = createFixture()

      await expect(service.extractText({ fileName: '恶意.exe', dataBase64: 'aGk=' }))
        .rejects.toThrow('不支持的文件格式: .exe')
    })

    it('拒绝超过大小上限的上传', async () => {
      const { service } = createFixture()
      const oversized = Buffer.alloc(MAX_UPLOAD_BYTES + 1).toString('base64')

      await expect(service.extractText({ fileName: 'big.pdf', dataBase64: oversized }))
        .rejects.toThrow('上限')
    })

    it('拒绝非法 base64（回归：前端误传 "[object ArrayBuffer]" 字面量）', async () => {
      const { service, extractFromFile } = createFixture()

      await expect(service.extractText({ fileName: 'a.doc', dataBase64: '[object ArrayBuffer]' }))
        .rejects.toThrow('不是有效的 base64 编码')
      expect(extractFromFile).not.toHaveBeenCalled()
    })

    it('拒绝空内容与缺参调用', async () => {
      const { service } = createFixture()

      await expect(service.extractText({})).rejects.toThrow('缺少必要参数')
      await expect(service.extractText()).rejects.toThrow('缺少必要参数')
    })
  })

  describe('testConnection', () => {
    it('表单参数优先于已存配置，返回模型/耗时/token', async () => {
      const { service, createProvider, provider } = createFixture()
      provider.chatCompletion.mockResolvedValue({
        content: 'OK',
        usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
      })

      const r = await service.testConnection({ baseURL: 'https://api.other.com', apiKey: 'sk-form', model: 'deepseek-v4-pro' })

      expect(createProvider).toHaveBeenCalledWith({
        baseURL: 'https://api.other.com',
        apiKey: 'sk-form',
        model: 'deepseek-v4-pro',
        timeoutMs: 15000,
      })
      expect(r).toEqual({ ok: true, model: 'deepseek-v4-pro', latencyMs: expect.any(Number), totalTokens: 12 })
    })

    it('参数缺省时回落到已存配置', async () => {
      const { service, createProvider, provider } = createFixture()
      provider.chatCompletion.mockResolvedValue({ content: 'OK', usage: { totalTokens: 5 } })

      await service.testConnection({})

      expect(createProvider).toHaveBeenCalledWith(expect.objectContaining({
        baseURL: 'https://api.deepseek.com',
        apiKey: 'sk-test',
      }))
    })

    it('缺 baseURL / Key 时给中文提示，API 错误原文透传', async () => {
      const { service } = createFixture({ loadConfig: () => ({}) })
      await expect(service.testConnection({})).rejects.toThrow('请先填写 baseURL')
      await expect(service.testConnection({ baseURL: 'https://x.com' })).rejects.toThrow('请先填写 API Key')

      const bad = createFixture()
      bad.provider.chatCompletion.mockRejectedValue(new Error('LLM API 错误 (400): 模型名不存在'))
      await expect(bad.service.testConnection({})).rejects.toThrow('LLM API 错误 (400)')
    })
  })

  describe('extractPoints', () => {
    it('docId 不匹配或未抽取过文档时报错', async () => {
      const { service } = createFixture()

      await expect(service.extractPoints({ docId: 'nope' }))
        .rejects.toThrow('文档缓存不存在或已过期')

      await service.extractText({ filePath: '/docs/手册.pdf' })
      await expect(service.extractPoints({ docId: 'still-wrong' }))
        .rejects.toThrow('文档缓存不存在或已过期')
    })

    it('LLM 配置缺失时给出可操作的中文提示', async () => {
      const cases = [
        [() => ({}), '尚未配置 LLM 服务'],
        [() => ({ llm: { apiKey: 'sk' } }), '缺少 baseURL'],
        [() => ({ llm: { baseURL: 'https://api.deepseek.com' } }), '缺少 API Key'],
      ]
      for (const [loadConfig, message] of cases) {
        const { service } = createFixture({ loadConfig })
        const { docId } = await service.extractText({ filePath: '/docs/手册.pdf' })
        await expect(service.extractPoints({ docId })).rejects.toThrow(message)
      }
    })

    it('正常流程：注入配置建 provider、转发进度事件、返回点位与统计', async () => {
      const { service, createProvider, extractPoints, provider } = createFixture()
      const progressEvents = []
      service.on('progress', p => progressEvents.push(p))

      const { docId } = await service.extractText({ filePath: '/docs/手册.pdf' })
      const result = await service.extractPoints({ docId })

      expect(createProvider).toHaveBeenCalledWith({
        baseURL: 'https://api.deepseek.com',
        apiKey: 'sk-test',
        model: 'deepseek-chat',
        timeoutMs: undefined,
      })
      expect(extractPoints).toHaveBeenCalledWith(expect.objectContaining({ provider }))
      expect(result.points).toHaveLength(1)
      expect(result.stats.totalTokens).toBe(240)
      expect(progressEvents).toEqual([
        { docId, segment: 1, totalSegments: 2, accumulatedPoints: 3, accumulatedTokens: 120 },
      ])
    })

    it('支持异步 loadConfig（网页模式 configStore）', async () => {
      const { service } = createFixture({
        loadConfig: vi.fn(async () => ({ llm: { baseURL: 'https://api.deepseek.com', apiKey: 'sk-async' } })),
      })
      const { docId } = await service.extractText({ filePath: '/docs/手册.pdf' })

      await expect(service.extractPoints({ docId })).resolves.toMatchObject({ points: expect.any(Array) })
    })

    it('同一时间只允许一个解析任务，任务结束后可再次启动', async () => {
      const gate = deferred()
      const extractPoints = vi.fn(async () => { await gate.promise; return { points: [], stats: {} } })
      const { service } = createFixture({ extractPoints })
      const { docId } = await service.extractText({ filePath: '/docs/手册.pdf' })

      const first = service.extractPoints({ docId })
      await expect(service.extractPoints({ docId })).rejects.toThrow('已有一个 LLM 解析任务在进行中')

      gate.resolve()
      await first
      await expect(service.extractPoints({ docId })).resolves.toEqual({ points: [], stats: {} })
    })

    it('任务失败后并发锁必须释放', async () => {
      const extractPoints = vi.fn()
        .mockRejectedValueOnce(new Error('LLM API 错误 (401)'))
        .mockResolvedValueOnce({ points: [], stats: {} })
      const { service } = createFixture({ extractPoints })
      const { docId } = await service.extractText({ filePath: '/docs/手册.pdf' })

      await expect(service.extractPoints({ docId })).rejects.toThrow('401')
      await expect(service.extractPoints({ docId })).resolves.toEqual({ points: [], stats: {} })
    })
  })
})
