// main/llm/provider.js — OpenAI 兼容 chat.completions 封装
// 支持超时、429/5xx 重试（2 次指数退避）

const DEFAULT_TIMEOUT_MS = 60000
const MAX_RETRIES = 2
const RETRY_BASE_DELAY_MS = 1000
/** DeepSeek 2026 命名：v4-pro / v4-flash（旧名 deepseek-chat 已下线） */
const DEFAULT_MODEL = 'deepseek-v4-flash'

/**
 * 创建 OpenAI 兼容的 LLM Provider
 * @param {{ baseURL: string, apiKey: string, model: string, timeoutMs?: number }} config
 * @returns {{ chatCompletion: (opts: { messages: Array<{role: string, content: string}>, temperature?: number, responseFormat?: object }) => Promise<{ content: string, usage: { promptTokens: number, completionTokens: number, totalTokens: number } }> }}
 */
function createProvider(config) {
  const baseURL = (config.baseURL || '').replace(/\/+$/, '')
  const apiKey = config.apiKey || ''
  const model = config.model || DEFAULT_MODEL
  const timeoutMs = config.timeoutMs || DEFAULT_TIMEOUT_MS

  if (!baseURL) throw new Error('缺少 baseURL 配置')
  if (!apiKey) throw new Error('缺少 apiKey 配置')

  /**
   * 发送一次 chat completion 请求
   */
  async function doRequest(messages, temperature = 0, responseFormat = undefined) {
    const url = `${baseURL}/chat/completions`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const body = {
        model,
        messages,
        temperature,
      }
      if (responseFormat) {
        body.response_format = responseFormat
      }

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      if (!response.ok) {
        const status = response.status
        let errorBody = ''
        try { errorBody = await response.text() } catch (_) { /* ignore */ }
        const err = new Error(`LLM API 错误 (${status}): ${errorBody}`)
        err.status = status
        throw err
      }

      const data = await response.json()
      const choice = data.choices && data.choices[0]
      if (!choice || !choice.message) {
        throw new Error(`LLM 返回格式异常: ${JSON.stringify(data).slice(0, 200)}`)
      }

      return {
        content: choice.message.content || '',
        usage: {
          promptTokens: data.usage?.prompt_tokens || 0,
          completionTokens: data.usage?.completion_tokens || 0,
          totalTokens: data.usage?.total_tokens || 0,
        },
      }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 带重试的 chat completion
   */
  async function chatCompletion(opts) {
    const { messages, temperature = 0, responseFormat } = opts || {}
    let lastError

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await doRequest(messages, temperature, responseFormat)
      } catch (err) {
        lastError = err
        // 仅对 429（频率限制）和 5xx（服务端错误）重试
        const isRetryable = err.status === 429 || (err.status >= 500 && err.status < 600)
        if (!isRetryable || attempt >= MAX_RETRIES) {
          throw err
        }
        // 指数退避: 1s, 2s
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt)
        await new Promise(resolve => setTimeout(resolve, delay))
      }
    }

    throw lastError
  }

  return { chatCompletion }
}

module.exports = { createProvider, DEFAULT_TIMEOUT_MS, MAX_RETRIES, DEFAULT_MODEL }
