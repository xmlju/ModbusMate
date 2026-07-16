import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { API_KEYS, API_LENGTHS, RPC_CHANNELS } from './api-contract.js'
import { closeWebApi, createWebApi, installWebApi } from '../renderer/web-api.js'

class FakeEventSource {
  static instances = []
  constructor(url) {
    this.url = url
    this.listeners = new Map()
    this.close = vi.fn()
    FakeEventSource.instances.push(this)
  }
  addEventListener(type, fn) { this.listeners.set(type, fn) }
  emit(type, data) { this.listeners.get(type)?.({ data }) }
}

function response(body, { ok = true, status = 200, rawText, contentLength } = {}) {
  const text = rawText ?? JSON.stringify(body)
  return {
    ok,
    status,
    headers: { get: vi.fn(name => name.toLowerCase() === 'content-length' ? (contentLength ?? null) : null) },
    text: vi.fn().mockResolvedValue(text),
  }
}

function setup(overrides = {}) {
  const fetch = overrides.fetch ?? vi.fn().mockResolvedValue(response({ ok: true, value: 'done' }))
  const api = createWebApi({
    location: { search: '?token=secret-token', origin: 'http://127.0.0.1:8765' },
    fetch,
    EventSource: FakeEventSource,
    console: { error: vi.fn() },
    ...overrides,
  })
  return { api, fetch, source: FakeEventSource.instances.at(-1) }
}

beforeEach(() => { FakeEventSource.instances.length = 0 })

describe('网页 API 契约与 RPC', () => {
  it('暴露与 Electron preload 完全相同的 API keys', () => {
    const { api } = setup()
    expect(Object.keys(api).sort()).toEqual([...API_KEYS].sort())
  })

  it('所有公开方法的 function.length 与 Electron preload 签名一致', () => {
    const { api } = setup()
    for (const [method, length] of Object.entries(API_LENGTHS)) {
      expect(api[method].length, method).toBe(length)
    }
  })

  it.each(Object.entries(RPC_CHANNELS))('%s 映射固定 RPC 通道并原样传递参数', async (method, channel) => {
    const { api, fetch } = setup()
    const noArgs = ['listSerialPorts', 'disconnect', 'stopPoll', 'loadConfig'].includes(method)
    await expect(noArgs ? api[method]() : api[method]({ sample: 1 })).resolves.toBe('done')
    expect(fetch).toHaveBeenCalledWith(`/api/invoke/${encodeURIComponent(channel)}`, expect.objectContaining({
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-ModbusMate-Token': 'secret-token' },
      body: JSON.stringify({ args: noArgs ? [] : [{ sample: 1 }] }),
      signal: expect.anything(),
    }))
  })

  it('无参数方法发送空 args，listSerialPorts 返回服务端数组', async () => {
    const fetch = vi.fn().mockResolvedValue(response({ ok: true, value: [{ path: 'COM3' }] }))
    const { api } = setup({ fetch })
    await expect(api.listSerialPorts()).resolves.toEqual([{ path: 'COM3' }])
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ args: [] })
  })

  it('恢复服务端 Error 的 message、code、causeMessage 和 errors', async () => {
    const fetch = vi.fn().mockResolvedValue(response({ ok: false, error: {
      message: '串口被占用', code: 'EBUSY', causeMessage: 'Access denied',
      errors: [{ message: '清理失败', code: 'ECLEAN' }],
    } }, { ok: false, status: 409 }))
    const { api } = setup({ fetch })
    const error = await api.connect({}).catch(value => value)
    expect(error).toMatchObject({ message: '串口被占用', code: 'EBUSY' })
    expect(error.cause).toMatchObject({ message: 'Access denied' })
    expect(error.errors[0]).toMatchObject({ message: '清理失败', code: 'ECLEAN' })
  })

  it('拒绝非 JSON、错误成功信封和网络异常，并保留 cause', async () => {
    const cases = [
      [response(null, { rawText: '{bad' }), '服务返回的不是有效 JSON'],
      [response({ value: 1 }), '服务响应格式无效'],
    ]
    for (const [reply, message] of cases) {
      const { api } = setup({ fetch: vi.fn().mockResolvedValue(reply) })
      const error = await api.loadConfig().catch(value => value)
      expect(error.message).toContain(message)
    }
    const cause = new TypeError('fetch failed')
    const { api } = setup({ fetch: vi.fn().mockRejectedValue(cause) })
    const error = await api.loadConfig().catch(value => value)
    expect(error.message).toContain('无法连接本地调试服务')
    expect(error.cause).toBe(cause)
  })

  it('超时会中止请求并返回中文错误', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
    }))
    const { api } = setup({ fetch, timeoutMs: 20 })
    const pending = api.connect({}).catch(value => value)
    await vi.advanceTimersByTimeAsync(21)
    const error = await pending
    expect(error.message).toContain('请求超时')
    vi.useRealTimers()
  })

  it('响应头返回后读取 JSON 仍受同一个超时控制', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn((_url, options) => Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: () => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(Object.assign(new Error('body aborted'), { name: 'AbortError' })))
      }),
    }))
    const { api } = setup({ fetch, timeoutMs: 20 })
    const pending = api.loadConfig().catch(value => value)
    await vi.advanceTimersByTimeAsync(21)
    expect((await pending).message).toContain('请求超时')
    vi.useRealTimers()
  })

  it.each([
    ['abc', '无效'],
    ['-1', '无效'],
    [String(2 * 1024 * 1024 + 1), '超过 2 MiB'],
  ])('拒绝无效或超限 Content-Length：%s', async (contentLength, expected) => {
    let signal
    const reply = response({ ok: true, value: 1 }, { contentLength })
    reply.body = { cancel: vi.fn(() => { throw new Error('cancel failed') }) }
    const fetch = vi.fn((_url, options) => {
      signal = options.signal
      return Promise.resolve(reply)
    })
    const { api } = setup({ fetch })
    await expect(api.loadConfig()).rejects.toThrow(expected)
    expect(signal.aborted).toBe(true)
    expect(reply.body.cancel).toHaveBeenCalledOnce()
  })

  it.each([
    [null, '无 Content-Length'],
    ['12', '伪小 Content-Length'],
  ])('%s 时仍按 UTF-8 实际字节数拒绝超大响应', async (contentLength) => {
    const rawText = JSON.stringify({ ok: true, value: '测'.repeat(700000) })
    expect(Buffer.byteLength(rawText, 'utf8')).toBeGreaterThan(2 * 1024 * 1024)
    const fetch = vi.fn().mockResolvedValue(response(null, { rawText, contentLength }))
    const { api } = setup({ fetch })
    await expect(api.loadConfig()).rejects.toThrow('超过 2 MiB')
  })

  it('接受 UTF-8 实际字节数恰好 2 MiB 的合法 JSON 响应', async () => {
    const base = JSON.stringify({ ok: true, value: 'boundary' })
    const rawText = base + ' '.repeat(2 * 1024 * 1024 - Buffer.byteLength(base, 'utf8'))
    expect(Buffer.byteLength(rawText, 'utf8')).toBe(2 * 1024 * 1024)
    const fetch = vi.fn().mockResolvedValue(response(null, { rawText, contentLength: String(2 * 1024 * 1024) }))
    const { api } = setup({ fetch })
    await expect(api.loadConfig()).resolves.toBe('boundary')
  })

  it.each(['', '?x=1', '?token=a&token=b', `?token=${'x'.repeat(257)}`])('token 无效时不联网且通信方法抛详细启动错误：%s', async search => {
    const fetch = vi.fn()
    const api = createWebApi({ location: { search }, fetch, EventSource: FakeEventSource })
    await expect(api.connect({})).rejects.toThrow('启动地址')
    expect(() => api.onData(() => {})).toThrow('启动地址')
    expect(fetch).not.toHaveBeenCalled()
    expect(FakeEventSource.instances).toHaveLength(0)
  })

  it('token 无效时仍保持完整 keys 和 preload 函数签名，且仅在调用时失败', async () => {
    const api = createWebApi({ location: { search: '' }, fetch: vi.fn(), EventSource: FakeEventSource })
    expect(Object.keys(api).sort()).toEqual([...API_KEYS].sort())
    expect(api.loadConfig.length).toBe(0)
    expect(api.connect.length).toBe(1)
    expect(api.importPoints.length).toBe(0)
    expect(api.exportPoints.length).toBe(1)
    await expect(api.exportPoints({})).rejects.toThrow('启动地址')
  })

  it('已有 Electron window.api 时绝不覆盖或联网', () => {
    const existing = { electron: true }
    const window = { api: existing, location: { search: '?token=x' }, addEventListener: vi.fn() }
    const fetch = vi.fn()
    expect(installWebApi(window, { fetch, EventSource: FakeEventSource })).toBe(existing)
    expect(window.api).toBe(existing)
    expect(fetch).not.toHaveBeenCalled()
    expect(FakeEventSource.instances).toHaveLength(0)
  })
})

describe('网页 SSE 事件桥', () => {
  it('只创建一个 EventSource，分发事件、去重订阅并支持取消订阅', () => {
    const { api, source } = setup()
    expect(source.url).toBe('/api/events?token=secret-token')
    const fn = vi.fn()
    const unsubscribe1 = api.onData(fn)
    const unsubscribe2 = api.onData(fn)
    source.emit('message', JSON.stringify({ channel: 'modbus:data', payload: { value: 7 } }))
    expect(fn).toHaveBeenCalledOnce()
    unsubscribe1(); unsubscribe2()
    source.emit('message', JSON.stringify({ channel: 'modbus:data', payload: { value: 8 } }))
    expect(fn).toHaveBeenCalledOnce()
  })

  it('listener 异常不阻断其他 listener，ready 与无效消息被忽略', async () => {
    const logger = { error: vi.fn() }
    const { api, source } = setup({ console: logger })
    const second = vi.fn()
    api.onStatus(() => { throw new Error('listener boom') })
    api.onStatus(second)
    source.emit('message', JSON.stringify({ channel: 'ready', payload: null }))
    source.emit('message', '{bad')
    source.emit('message', JSON.stringify({ channel: 'modbus:status', payload: { state: 'connected' } }))
    expect(second).toHaveBeenCalledOnce()
    await Promise.resolve()
    expect(logger.error).toHaveBeenCalled()
  })

  it('SSE error 向两类日志节流通知，close 关闭连接', () => {
    vi.useFakeTimers()
    const { api, source } = setup({ sseErrorThrottleMs: 1000 })
    const modbusLog = vi.fn(); const deviceLog = vi.fn()
    api.onLog(modbusLog); api.onDeviceLog(deviceLog)
    source.emit('error'); source.emit('error')
    expect(modbusLog).toHaveBeenCalledOnce()
    expect(deviceLog).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(1001)
    source.emit('error')
    expect(modbusLog).toHaveBeenCalledTimes(2)
    closeWebApi(api)
    expect(source.close).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })
})

describe('网页本地文件安全实现', () => {
  it('导出 JSON 时清理文件名并释放 object URL', async () => {
    vi.useFakeTimers()
    const anchor = { click: vi.fn(), remove: vi.fn() }
    const document = {
      createElement: vi.fn(tag => tag === 'a' ? anchor : {}),
      body: { appendChild: vi.fn() },
    }
    const URL = { createObjectURL: vi.fn(() => 'blob:test'), revokeObjectURL: vi.fn() }
    const { api } = setup({ document, URL, Blob })
    await expect(api.exportPoints({ defaultName: '../bad\0/name.json', json: '{}' })).resolves.toEqual({ ok: true })
    expect(anchor.download).toBe('name.json')
    expect(anchor.click).toHaveBeenCalledOnce()
    await vi.runAllTimersAsync()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test')
    vi.useRealTimers()
  })

  it('导出点击抛错时仍移除 anchor 并释放 object URL', async () => {
    const clickError = new Error('download blocked')
    const anchor = { click: vi.fn(() => { throw clickError }), remove: vi.fn(), style: {} }
    const document = { createElement: vi.fn(() => anchor), body: { appendChild: vi.fn() } }
    const URL = { createObjectURL: vi.fn(() => 'blob:failed'), revokeObjectURL: vi.fn() }
    const { api } = setup({ document, URL, Blob })
    await expect(api.exportPoints({ defaultName: 'points.json', json: '{}' })).rejects.toBe(clickError)
    expect(anchor.remove).toHaveBeenCalledOnce()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:failed')
  })

  it('文件选择器适配器支持取消、读取以及 1 MiB 上限', async () => {
    const canceled = setup({ pickFile: vi.fn().mockResolvedValue(null) }).api
    await expect(canceled.importPoints()).resolves.toEqual({ ok: false, canceled: true })

    const validFile = { size: 2, text: vi.fn().mockResolvedValue('{}') }
    const valid = setup({ pickFile: vi.fn().mockResolvedValue(validFile) }).api
    await expect(valid.importPoints()).resolves.toEqual({ ok: true, content: '{}' })

    const huge = setup({ pickFile: vi.fn().mockResolvedValue({ size: 1024 * 1024 + 1 }) }).api
    await expect(huge.importPoints()).resolves.toMatchObject({ ok: false, error: expect.stringContaining('1 MiB') })
  })

  it('默认文件选择器 click 抛错时清理 DOM 和 focus listener', async () => {
    const clickError = new Error('picker blocked')
    const input = {
      files: [], style: {},
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      click: vi.fn(() => { throw clickError }), remove: vi.fn(),
    }
    const document = { createElement: vi.fn(() => input), body: { appendChild: vi.fn() } }
    const window = { addEventListener: vi.fn(), removeEventListener: vi.fn() }
    const { api } = setup({ document, window })
    await expect(api.importPoints()).resolves.toEqual({ ok: false, error: '读取导入文件失败：picker blocked' })
    expect(input.remove).toHaveBeenCalledOnce()
    expect(window.removeEventListener).toHaveBeenCalledWith('focus', expect.any(Function))
  })

  it('默认文件选择器在 focus 先于 change 触发时仍等待正常选择结果', async () => {
    vi.useFakeTimers()
    const selectedFile = { size: 2, text: vi.fn().mockResolvedValue('{}') }
    const listeners = {}
    const input = {
      files: [], style: {}, remove: vi.fn(),
      addEventListener: vi.fn((type, fn) => { listeners[type] = fn }),
      removeEventListener: vi.fn(),
      click: vi.fn(),
    }
    const document = { createElement: vi.fn(() => input), body: { appendChild: vi.fn() } }
    const window = {
      addEventListener: vi.fn((type, fn) => { listeners[`window:${type}`] = fn }),
      removeEventListener: vi.fn(),
    }
    const { api } = setup({ document, window })

    const pending = api.importPoints()
    listeners['window:focus']()
    input.files = [selectedFile]
    listeners.change()
    await vi.runAllTimersAsync()

    await expect(pending).resolves.toEqual({ ok: true, content: '{}' })
    expect(selectedFile.text).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })

  it('pagehide 会取消活动文件选择器并可靠返回 canceled', async () => {
    const input = {
      files: [], style: {}, click: vi.fn(), remove: vi.fn(),
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
    }
    const document = { createElement: vi.fn(() => input), body: { appendChild: vi.fn() } }
    const handlers = {}
    const window = {
      location: { search: '?token=secret-token', origin: 'http://127.0.0.1:8765' },
      document,
      addEventListener: vi.fn((type, fn) => { handlers[type] = fn }),
      removeEventListener: vi.fn(),
    }
    const api = installWebApi(window, {
      fetch: vi.fn().mockResolvedValue(response({ ok: true, value: null })),
      EventSource: FakeEventSource,
      AbortController,
      URL,
      Blob,
      console: { error: vi.fn() },
    })
    const pending = api.importPoints()
    handlers.pagehide()
    await expect(pending).resolves.toEqual({ ok: false, canceled: true })
    expect(input.remove).toHaveBeenCalledOnce()
  })

  it('图片 API 只接受受限 data/blob/同源 URL，且不开放本地路径', async () => {
    const { api } = setup()
    await expect(api.copyImage('/etc/passwd')).rejects.toThrow('网页模式不支持')
    await expect(api.readImage('file:///etc/passwd')).rejects.toThrow('只允许')
    await expect(api.readImage('https://evil.example/a.png')).rejects.toThrow('同源')
    await expect(api.readImage('data:image/png;base64,AA==')).resolves.toBe('data:image/png;base64,AA==')
    await expect(api.readImage('blob:http://127.0.0.1:8765/id')).resolves.toBe('blob:http://127.0.0.1:8765/id')
    await expect(api.saveImage('data:text/plain;base64,QQ==')).rejects.toThrow('data:image')
    await expect(api.saveImage('data:image/png;base64,AA==')).resolves.toBe('data:image/png;base64,AA==')
  })

  it('readImage 和 saveImage 按 base64 解码后字节数执行 5 MiB 边界', async () => {
    const { api } = setup()
    const atLimit = `data:image/png;base64,${Buffer.alloc(5 * 1024 * 1024).toString('base64')}`
    const overLimit = `data:image/png;base64,${Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64')}`
    await expect(api.readImage(atLimit)).resolves.toBe(atLimit)
    await expect(api.saveImage(atLimit)).resolves.toBe(atLimit)
    await expect(api.readImage(overLimit)).rejects.toThrow('5 MiB')
    await expect(api.saveImage(overLimit)).rejects.toThrow('5 MiB')
  })
})

describe('页面加载顺序与 CSP', () => {
  it('web-api 在业务脚本前加载且 meta CSP 与服务端一致', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8')
    expect(html.indexOf('src="web-api.js"')).toBeGreaterThan(-1)
    expect(html.indexOf('src="web-api.js"')).toBeLessThan(html.indexOf('src="seed-data.js"'))
    expect(html).toContain("default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'")
  })
})
