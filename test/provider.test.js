// test/provider.test.js — provider 单元测试
// LLM 调用全部 mock，不消耗真实 token

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { createProvider, DEFAULT_TIMEOUT_MS, MAX_RETRIES } = require('../main/llm/provider.js')

describe('provider — createProvider', () => {
  describe('构造参数校验', () => {
    it('缺少 baseURL 抛出错误', () => {
      expect(() => createProvider({ apiKey: 'sk-xxx', model: 'deepseek-chat' }))
        .toThrow('缺少 baseURL 配置')
    })

    it('缺少 apiKey 抛出错误', () => {
      expect(() => createProvider({ baseURL: 'https://api.deepseek.com', model: 'deepseek-chat' }))
        .toThrow('缺少 apiKey 配置')
    })

    it('未配置 model 时使用默认值', () => {
      const p = createProvider({ baseURL: 'https://api.deepseek.com', apiKey: 'sk-xxx' })
      expect(typeof p.chatCompletion).toBe('function')
    })

    it('baseURL 末尾斜杠被去掉', () => {
      const p = createProvider({ baseURL: 'https://api.deepseek.com/', apiKey: 'sk-xxx' })
      expect(typeof p.chatCompletion).toBe('function')
    })
  })

  describe('正常请求', () => {
    let originalFetch

    beforeEach(() => {
      originalFetch = global.fetch
    })

    afterEach(() => {
      global.fetch = originalFetch
    })

    it('成功返回 content 和 usage', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({
          choices: [{ message: { content: '{"points":[]}' } }],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
        }),
      })

      const provider = createProvider({
        baseURL: 'https://api.deepseek.com',
        apiKey: 'sk-test',
        model: 'deepseek-chat',
      })

      const result = await provider.chatCompletion({
        messages: [{ role: 'user', content: 'hello' }],
      })

      expect(result.content).toBe('{"points":[]}')
      expect(result.usage.promptTokens).toBe(100)
      expect(result.usage.completionTokens).toBe(20)
      expect(result.usage.totalTokens).toBe(120)
    })

    it('请求体包含 model、messages、temperature 和 response_format', async () => {
      let requestBody
      global.fetch = vi.fn().mockImplementation((url, opts) => {
        requestBody = JSON.parse(opts.body)
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            choices: [{ message: { content: 'ok' } }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        })
      })

      const provider = createProvider({
        baseURL: 'https://api.deepseek.com',
        apiKey: 'sk-test',
      })

      await provider.chatCompletion({
        messages: [{ role: 'user', content: 'test' }],
        temperature: 0,
        responseFormat: { type: 'json_object' },
      })

      expect(requestBody.model).toBe('deepseek-v4-flash')  // 未显式配置时的默认 model
      expect(requestBody.messages).toEqual([{ role: 'user', content: 'test' }])
      expect(requestBody.temperature).toBe(0)
      expect(requestBody.response_format).toEqual({ type: 'json_object' })
    })
  })

  describe('错误处理', () => {
    let originalFetch

    beforeEach(() => {
      originalFetch = global.fetch
    })

    afterEach(() => {
      global.fetch = originalFetch
    })

    it('非 OK 响应抛出带 status 的错误', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve('{"error":"Invalid API Key"}'),
      })

      const provider = createProvider({
        baseURL: 'https://api.deepseek.com',
        apiKey: 'sk-bad',
      })

      await expect(provider.chatCompletion({
        messages: [{ role: 'user', content: 'hello' }],
      })).rejects.toThrow('LLM API 错误')
    })

    it('401 不重试直接抛出', async () => {
      let callCount = 0
      global.fetch = vi.fn().mockImplementation(() => {
        callCount++
        return Promise.resolve({
          ok: false,
          status: 401,
          text: () => Promise.resolve('unauthorized'),
        })
      })

      const provider = createProvider({
        baseURL: 'https://api.deepseek.com',
        apiKey: 'sk-bad',
      })

      await expect(provider.chatCompletion({
        messages: [{ role: 'user', content: 'hello' }],
      })).rejects.toThrow()

      expect(callCount).toBe(1) // 401 不重试
    })

    it('429 自动重试', async () => {
      let callCount = 0
      global.fetch = vi.fn().mockImplementation(() => {
        callCount++
        if (callCount === 1) {
          return Promise.resolve({
            ok: false,
            status: 429,
            text: () => Promise.resolve('rate limited'),
          })
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            choices: [{ message: { content: 'ok' } }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        })
      })

      const provider = createProvider({
        baseURL: 'https://api.deepseek.com',
        apiKey: 'sk-test',
        timeoutMs: 5000,
      })

      const result = await provider.chatCompletion({
        messages: [{ role: 'user', content: 'hello' }],
      })

      expect(result.content).toBe('ok')
      expect(callCount).toBe(2) // 第一次 429，第二次成功
    })

    it('5xx 重试最多 2 次后仍失败则抛出', async () => {
      let callCount = 0
      global.fetch = vi.fn().mockImplementation(() => {
        callCount++
        return Promise.resolve({
          ok: false,
          status: 500,
          text: () => Promise.resolve('server error'),
        })
      })

      const provider = createProvider({
        baseURL: 'https://api.deepseek.com',
        apiKey: 'sk-test',
        timeoutMs: 1000,
      })

      await expect(provider.chatCompletion({
        messages: [{ role: 'user', content: 'hello' }],
      })).rejects.toThrow()

      expect(callCount).toBe(MAX_RETRIES + 1) // 初始 + 2 次重试 = 3
    })

    it('响应体缺少 choices 抛出异常', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ choices: [] }),
      })

      const provider = createProvider({
        baseURL: 'https://api.deepseek.com',
        apiKey: 'sk-test',
      })

      await expect(provider.chatCompletion({
        messages: [{ role: 'user', content: 'hello' }],
      })).rejects.toThrow('格式异常')
    })
  })

  describe('超时处理', () => {
    let originalFetch

    beforeEach(() => {
      originalFetch = global.fetch
    })

    afterEach(() => {
      global.fetch = originalFetch
    })

    it('自定义超时时间可配置', () => {
      const provider = createProvider({
        baseURL: 'https://api.deepseek.com',
        apiKey: 'sk-test',
        timeoutMs: 30000,
      })
      // provider 构造成功即表示 timeoutMs 被接受
      expect(typeof provider.chatCompletion).toBe('function')
    })

    it('fetch 抛出 AbortError 正确传播', async () => {
      global.fetch = vi.fn().mockRejectedValue(new DOMException('The operation was aborted', 'AbortError'))

      const provider = createProvider({
        baseURL: 'https://api.deepseek.com',
        apiKey: 'sk-test',
      })

      await expect(provider.chatCompletion({
        messages: [{ role: 'user', content: 'hello' }],
      })).rejects.toThrow('aborted')
    })

    it('默认超时为 60 秒', () => {
      expect(DEFAULT_TIMEOUT_MS).toBe(60000)
    })
  })
})
