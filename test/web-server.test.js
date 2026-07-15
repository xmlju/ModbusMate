import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'

const { startWebServer } = require('../main/web-server')
const { parseCliArgs, createOpenCommand } = require('../scripts/start-web')

const running = new Set()

function createRuntime() {
  return Object.assign(new EventEmitter(), {
    invoke: vi.fn(async (channel, ...args) => ({ channel, args })),
    close: vi.fn(async () => undefined),
  })
}

async function start(options = {}) {
  const runtime = options.runtime ?? createRuntime()
  const app = await startWebServer({ port: 0, token: 'test-token-123', runtime, ...options })
  running.add(app)
  return app
}

async function close(app) {
  running.delete(app)
  await app.close()
}

function request(app, { method = 'GET', pathname = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: app.address.port,
      method,
      path: pathname,
      headers,
    }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        text: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

function rpcHeaders(app, extra = {}) {
  return {
    host: `127.0.0.1:${app.address.port}`,
    origin: app.origin,
    'content-type': 'application/json',
    'x-modbusmate-token': app.token,
    ...extra,
  }
}

afterEach(async () => {
  await Promise.allSettled([...running].map(app => app.close()))
  running.clear()
})

describe('安全本地 Web 服务', () => {
  it('只监听回环地址并返回可访问 URL', async () => {
    const app = await start()

    expect(app.address.address).toBe('127.0.0.1')
    expect(app.origin).toBe(`http://127.0.0.1:${app.address.port}`)
    expect(app.url).toBe(`${app.origin}/?token=test-token-123`)
    await expect(startWebServer({ host: '0.0.0.0', port: 0, runtime: createRuntime() }))
      .rejects.toThrow('只允许监听本机回环地址')

    await close(app)
  })

  it('静态 GET/HEAD 返回正确 MIME 和安全响应头', async () => {
    const app = await start()
    const index = await request(app)
    const css = await request(app, { pathname: '/style.css' })
    const head = await request(app, { method: 'HEAD', pathname: '/app.js' })

    expect(index.status).toBe(200)
    expect(index.text).toContain('<!DOCTYPE html>')
    expect(index.headers['content-type']).toContain('text/html')
    expect(index.headers['content-security-policy']).toBe(
      "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    )
    expect(index.headers['x-content-type-options']).toBe('nosniff')
    expect(index.headers['cache-control']).toBe('no-store')
    expect(index.headers['referrer-policy']).toBe('no-referrer')
    expect(css.headers['content-type']).toContain('text/css')
    expect(head.status).toBe(200)
    expect(head.text).toBe('')
    expect(Number(head.headers['content-length'])).toBeGreaterThan(0)

    await close(app)
  })

  it.each([
    '/%E0%A4%A',
    '/%00secret',
    '/..%2fpackage.json',
    '/%2e%2e/package.json',
    '/..%5cpackage.json',
    '/%5c%5cserver/share',
  ])('拒绝非法或路径穿越静态地址 %s', async pathname => {
    const app = await start()
    const response = await request(app, { pathname })
    expect([400, 403, 404]).toContain(response.status)
    expect(response.text).not.toContain('"name": "modbusmate"')
    await close(app)
  })

  it('拒绝通过符号链接逃逸 renderer 根目录', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'modbusmate-web-'))
    const outside = path.join(root, '..', `outside-${path.basename(root)}.txt`)
    fs.writeFileSync(path.join(root, 'index.html'), '<h1>ok</h1>')
    fs.writeFileSync(outside, 'secret-outside')
    fs.symlinkSync(outside, path.join(root, 'leak.txt'))
    const app = await start({ rendererRoot: root })

    const response = await request(app, { pathname: '/leak.txt' })
    expect(response.status).toBe(403)
    expect(response.text).not.toContain('secret-outside')

    await close(app)
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(outside, { force: true })
  })

  it('RPC 只接受同源、正确 Host 和常量时间校验 token 的 JSON 请求', async () => {
    const runtime = createRuntime()
    const app = await start({ runtime })
    const valid = await request(app, {
      method: 'POST',
      pathname: '/api/invoke/config%3Aload',
      headers: rpcHeaders(app),
      body: '{"args":[]}',
    })

    expect(valid.status).toBe(200)
    expect(JSON.parse(valid.text)).toEqual({
      ok: true,
      value: { channel: 'config:load', args: [] },
    })
    expect(runtime.invoke).toHaveBeenCalledWith('config:load')

    const cases = [
      [{ 'x-modbusmate-token': undefined }, 401],
      [{ 'x-modbusmate-token': 'wrong' }, 401],
      [{ origin: undefined }, 403],
      [{ origin: 'http://evil.example' }, 403],
      [{ host: 'localhost:8765' }, 403],
    ]
    for (const [override, status] of cases) {
      const headers = rpcHeaders(app, override)
      for (const [name, value] of Object.entries(headers)) {
        if (value === undefined) delete headers[name]
      }
      const response = await request(app, {
        method: 'POST', pathname: '/api/invoke/config%3Aload', headers, body: '{"args":[]}',
      })
      expect(response.status).toBe(status)
    }

    await close(app)
  })

  it('RPC 校验方法、Content-Type、JSON 和 args 数组', async () => {
    const app = await start()
    const get = await request(app, {
      pathname: '/api/invoke/config%3Aload',
      headers: rpcHeaders(app),
    })
    expect(get.status).toBe(405)
    expect(get.headers.allow).toBe('POST')

    const wrongType = await request(app, {
      method: 'POST', pathname: '/api/invoke/config%3Aload',
      headers: rpcHeaders(app, { 'content-type': 'text/plain' }), body: '{"args":[]}',
    })
    expect(wrongType.status).toBe(415)

    for (const body of ['{bad', '{}', '{"args":{}}']) {
      const response = await request(app, {
        method: 'POST', pathname: '/api/invoke/config%3Aload', headers: rpcHeaders(app), body,
      })
      expect(response.status).toBe(400)
    }
    await close(app)
  })

  it('RPC 的鉴权、路由和格式错误统一返回安全 JSON 错误信封', async () => {
    const app = await start()
    const cases = [
      await request(app, {
        method: 'POST', pathname: '/api/invoke/config%3Aload',
        headers: rpcHeaders(app, { 'x-modbusmate-token': 'bad' }), body: '{"args":[]}',
      }),
      await request(app, {
        method: 'POST', pathname: '/api/invoke/not%3Aregistered',
        headers: rpcHeaders(app), body: '{"args":[]}',
      }),
      await request(app, {
        method: 'POST', pathname: '/api/invoke/config%3Aload',
        headers: rpcHeaders(app), body: '{}',
      }),
    ]

    for (const response of cases) {
      expect(response.headers['content-type']).toContain('application/json')
      expect(JSON.parse(response.text)).toEqual({
        ok: false,
        error: { message: expect.any(String) },
      })
    }
    await close(app)
  })

  it('RPC 拒绝超过 1 MiB 的请求体', async () => {
    const app = await start()
    const body = JSON.stringify({ args: ['x'.repeat(1024 * 1024)] })
    const response = await request(app, {
      method: 'POST', pathname: '/api/invoke/config%3Aload',
      headers: rpcHeaders(app, { 'content-length': Buffer.byteLength(body) }), body,
    })
    expect(response.status).toBe(413)
    await close(app)
  })

  it.each(['not:registered', 'toString', 'constructor', '__proto__', 'config%2Fload', '%E0%A4%A'])(
    '未知或非法 RPC 通道返回 404：%s',
    async channel => {
      const runtime = createRuntime()
      const app = await start({ runtime })
      const response = await request(app, {
        method: 'POST', pathname: `/api/invoke/${channel}`,
        headers: rpcHeaders(app), body: '{"args":[]}',
      })
      expect(response.status).toBe(404)
      expect(runtime.invoke).not.toHaveBeenCalled()
      await close(app)
    },
  )

  it('RPC 错误只返回可序列化详情且不泄漏堆栈和本地数据目录', async () => {
    const runtime = createRuntime()
    runtime.invoke.mockRejectedValue(Object.assign(
      new Error('配置读取失败：/Users/test/.modbusmate/config.json', {
        cause: new Error('permission denied /Users/test/.modbusmate/config.json'),
      }),
      { code: 'EACCES', stack: 'SECRET_STACK', errors: [new Error('子错误')] },
    ))
    const app = await start({ runtime, dataDir: '/Users/test/.modbusmate' })
    const response = await request(app, {
      method: 'POST', pathname: '/api/invoke/config%3Aload',
      headers: rpcHeaders(app), body: '{"args":[]}',
    })
    const payload = JSON.parse(response.text)

    expect(response.status).toBe(500)
    expect(payload.ok).toBe(false)
    expect(payload.error).toMatchObject({ code: 'EACCES', errors: [{ message: '子错误' }] })
    expect(response.text).not.toContain('SECRET_STACK')
    expect(response.text).not.toContain('/Users/test/.modbusmate')
    await close(app)
  })

  it('SSE 验证 token、发送 ready、转发事件并在断开时清监听', async () => {
    const runtime = createRuntime()
    const app = await start({ runtime, heartbeatMs: 20 })
    const denied = await request(app, { pathname: '/api/events?token=wrong' })
    expect(denied.status).toBe(401)

    const received = await new Promise((resolve, reject) => {
      const req = http.get(`${app.origin}/api/events?token=${encodeURIComponent(app.token)}`, {
        headers: { origin: app.origin },
      }, res => {
        let text = ''
        res.on('data', chunk => {
          text += chunk
          if (text.includes('ready') && !text.includes('device:data')) {
            runtime.emit('event', { channel: 'device:data', payload: { id: 'ems' } })
          }
          if (text.includes('device:data')) {
            req.destroy()
            resolve({ status: res.statusCode, headers: res.headers, text })
          }
        })
      })
      req.on('error', error => {
        if (error.code !== 'ECONNRESET') reject(error)
      })
    })

    expect(received.status).toBe(200)
    expect(received.headers['content-type']).toContain('text/event-stream')
    expect(received.text).toContain('"channel":"ready"')
    expect(received.text).toContain('"channel":"device:data"')
    await vi.waitFor(() => expect(runtime.listenerCount('event')).toBe(0))
    await close(app)
  })

  it('close 幂等并同时关闭 SSE、监听端口和运行时', async () => {
    const runtime = createRuntime()
    const app = await start({ runtime })
    const port = app.address.port
    const first = app.close()
    const second = app.close()
    expect(first).toBe(second)
    await first
    running.delete(app)
    expect(runtime.close).toHaveBeenCalledTimes(1)
    await expect(new Promise((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${port}/`, resolve)
      req.on('error', reject)
    })).rejects.toMatchObject({ code: 'ECONNREFUSED' })
  })

  it('close 主动结束仍连接的 SSE 并移除运行时监听器', async () => {
    const runtime = createRuntime()
    const app = await start({ runtime })
    const ended = new Promise((resolve, reject) => {
      const req = http.get(`${app.origin}/api/events?token=${encodeURIComponent(app.token)}`, res => {
        res.once('data', () => app.close().catch(reject))
        res.once('end', resolve)
      })
      req.on('error', reject)
    })

    await ended
    running.delete(app)
    expect(runtime.listenerCount('event')).toBe(0)
    expect(runtime.close).toHaveBeenCalledTimes(1)
  })

  it('监听失败仍关闭已创建运行时', async () => {
    const occupied = http.createServer()
    await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve))
    const runtime = createRuntime()

    await expect(startWebServer({
      host: '127.0.0.1', port: occupied.address().port, runtime,
    })).rejects.toMatchObject({ code: 'EADDRINUSE' })
    expect(runtime.close).toHaveBeenCalledTimes(1)
    await new Promise(resolve => occupied.close(resolve))
  })
})

describe('Web CLI 纯函数', () => {
  it('解析 --no-open、--port 和环境变量', () => {
    expect(parseCliArgs(['--no-open', '--port', '9001'], {
      MODBUSMATE_WEB_PORT: '8123', MODBUSMATE_DATA_DIR: '/tmp/mm',
    })).toEqual({ open: false, port: 9001, dataDir: '/tmp/mm' })
    expect(parseCliArgs([], { MODBUSMATE_WEB_PORT: '8123' })).toMatchObject({ open: true, port: 8123 })
    expect(() => parseCliArgs(['--port', 'bad'], {})).toThrow('端口')
  })

  it('按平台生成不经过 shell 拼接的浏览器启动参数', () => {
    const url = 'http://127.0.0.1:8765/?token=a%20b'
    expect(createOpenCommand('darwin', url)).toEqual({ command: 'open', args: [url] })
    expect(createOpenCommand('win32', url)).toEqual({
      command: 'cmd', args: ['/c', 'start', '', url], windowsVerbatimArguments: true,
    })
    expect(createOpenCommand('linux', url)).toEqual({ command: 'xdg-open', args: [url] })
  })
})
