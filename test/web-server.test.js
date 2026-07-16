import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import fs from 'fs'
import http from 'http'
import net from 'net'
import os from 'os'
import path from 'path'

const { startWebServer } = require('../main/web-server')
const { parseCliArgs, createOpenCommand } = require('../scripts/start-web')
const { createWebRuntime } = require('../main/web-runtime')
const { createConfigStore } = require('../main/config-store')

const running = new Set()

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

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

  it('requireToken=false 时免令牌放行 RPC（局域网便捷模式）', async () => {
    const app = await start({ allowLan: true, requireToken: false })
    expect(app.url.includes('token=')).toBe(false)  // 干净地址
    const lanHost = '192.168.1.60:' + app.address.port
    const res = await request(app, {
      method: 'POST', pathname: '/api/invoke/config%3Aload',
      headers: { host: lanHost, origin: `http://${lanHost}`, 'content-type': 'application/json' }, // 无 token 头
      body: '{"args":[]}',
    })
    expect(res.status).toBe(200)
    await close(app)
  })

  it('allowLan 开启后绑定 0.0.0.0，并按动态同源校验 RPC', async () => {
    const app = await start({ allowLan: true })
    expect(app.address.address).toBe('0.0.0.0')

    // 模拟局域网访问：Host 为局域网地址，Origin 与之同源 → 允许
    const lanHost = '192.168.1.50:' + app.address.port
    const ok = await request(app, {
      method: 'POST', pathname: '/api/invoke/config%3Aload',
      headers: {
        host: lanHost, origin: `http://${lanHost}`,
        'content-type': 'application/json', 'x-modbusmate-token': app.token,
      },
      body: '{"args":[]}',
    })
    expect(ok.status).toBe(200)

    // 跨站：Origin 与 Host 不一致 → 403（防 CSRF）
    const csrf = await request(app, {
      method: 'POST', pathname: '/api/invoke/config%3Aload',
      headers: {
        host: lanHost, origin: 'http://evil.test',
        'content-type': 'application/json', 'x-modbusmate-token': app.token,
      },
      body: '{"args":[]}',
    })
    expect(csrf.status).toBe(403)

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

  it('SSE 客户端产生背压后立即断开、清监听且不再接收事件', async () => {
    const runtime = createRuntime()
    const app = await start({ runtime, sseMaxBufferedBytes: 1024 })
    let req
    try {
      await new Promise((resolve, reject) => {
        req = http.get(`${app.origin}/api/events?token=${encodeURIComponent(app.token)}`, res => {
          res.on('error', () => undefined)
          res.once('data', () => {
            res.pause()
            resolve()
          })
        })
        req.on('error', error => {
          if (error.code !== 'ECONNRESET') reject(error)
        })
      })

      runtime.emit('event', { channel: 'device:data', payload: { text: 'x'.repeat(64 * 1024) } })
      await vi.waitFor(() => expect(runtime.listenerCount('event')).toBe(0))
      expect(runtime.emit('event', { channel: 'device:data', payload: { text: 'later' } })).toBe(false)
    } finally {
      req?.destroy()
      await close(app)
    }
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

  it('未完成请求体不能永久阻塞 close，宽限期后释放 socket 和端口', async () => {
    const runtime = createRuntime()
    const app = await start({ runtime, shutdownGraceMs: 30 })
    const socket = net.createConnection({ host: '127.0.0.1', port: app.address.port })
    socket.on('error', () => undefined)
    await new Promise(resolve => socket.once('connect', resolve))
    socket.write([
      'POST /api/invoke/config%3Aload HTTP/1.1',
      `Host: 127.0.0.1:${app.address.port}`,
      `Origin: ${app.origin}`,
      `X-ModbusMate-Token: ${app.token}`,
      'Content-Type: application/json',
      'Content-Length: 100',
      'Connection: keep-alive',
      '',
      '{"args":[',
    ].join('\r\n'))
    await new Promise(resolve => setTimeout(resolve, 20))

    const closing = app.close()
    const outcome = await Promise.race([
      closing.then(() => 'closed'),
      new Promise(resolve => setTimeout(() => resolve('timeout'), 250)),
    ])
    if (outcome === 'timeout') socket.destroy()
    await closing
    running.delete(app)

    expect(outcome).toBe('closed')
    expect(runtime.close).toHaveBeenCalledTimes(1)
    await expect(new Promise((resolve, reject) => {
      const req = http.get(`${app.origin}/`, resolve)
      req.on('error', reject)
    })).rejects.toMatchObject({ code: 'ECONNREFUSED' })
  })

  it('close 的宽限期允许正常在途短请求完成', async () => {
    const runtime = createRuntime()
    const entered = deferred()
    const finish = deferred()
    let runtimeClosed = false
    runtime.close.mockImplementation(async () => { runtimeClosed = true })
    runtime.invoke.mockImplementation(async () => {
      entered.resolve()
      await finish.promise
      if (runtimeClosed) throw new Error('运行时被过早关闭')
      return '完成'
    })
    const app = await start({ runtime, shutdownGraceMs: 100 })
    const responsePromise = request(app, {
      method: 'POST', pathname: '/api/invoke/config%3Aload',
      headers: rpcHeaders(app), body: '{"args":[]}',
    })
    await entered.promise

    const first = app.close()
    const second = app.close()
    setTimeout(() => finish.resolve(), 10)
    const startedAt = Date.now()
    const [response] = await Promise.all([responsePromise, first])
    running.delete(app)

    expect(first).toBe(second)
    expect(Date.now() - startedAt).toBeLessThan(250)
    expect(response.status).toBe(200)
    expect(JSON.parse(response.text)).toEqual({ ok: true, value: '完成' })
    expect(runtime.close).toHaveBeenCalledTimes(1)
  })

  it('HTTP 关闭辅助步骤同步异常时仍关闭运行时并返回聚合错误', async () => {
    const runtime = createRuntime()
    const app = await start({ runtime })
    app.server.closeIdleConnections = () => { throw new Error('关闭空闲连接失败') }

    let error
    try { await app.close() } catch (caught) { error = caught }
    running.delete(app)

    expect(error).toBeInstanceOf(AggregateError)
    expect(error.message).toContain('本地 Web 服务关闭失败')
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

describe('浏览器入口冒烟', () => {
  function createRealRuntime(configFilePath) {
    const service = { connect: vi.fn(async () => undefined), disconnect: vi.fn(async () => undefined), write: vi.fn(async () => undefined) }
    const poller = Object.assign(new EventEmitter(), { running: false, start: vi.fn(), stop: vi.fn() })
    const deviceManager = Object.assign(new EventEmitter(), { stopAll: vi.fn(async () => undefined) })
    const listSerialPorts = vi.fn(async () => [{ path: 'COM3', manufacturer: 'FTDI' }, { path: '/dev/tty.usbserial-1' }])
    return createWebRuntime({
      service, poller, deviceManager, listSerialPorts,
      configStore: createConfigStore(configFilePath),
    })
  }

  it('GET / 返回调试页面，全部渲染脚本静态资源均可 200 加载', async () => {
    const app = await start()
    const index = await request(app)
    expect(index.status).toBe(200)
    expect(index.text).toContain('<!DOCTYPE html>')

    const scripts = [...index.text.matchAll(/<script src="([a-zA-Z0-9._-]+\.js)"/g)].map(m => m[1])
    expect(scripts).toEqual(expect.arrayContaining([
      'web-api.js', 'connection-ui.js', 'codec.js', 'read-plan.js', 'seed-data.js', 'device-config.js', 'device.js', 'app.js',
    ]))
    for (const script of scripts) {
      const response = await request(app, { pathname: `/${script}` })
      expect(response.status, script).toBe(200)
    }

    await close(app)
  })

  it('config:save / config:load 通过真实配置存储原样往返', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modbusmate-web-config-'))
    const runtime = createRealRuntime(path.join(dir, 'config.json'))
    const app = await start({ runtime })

    const saved = { transport: 'rtu', serialPath: 'COM3', baudRate: 9600 }
    const saveRes = await request(app, {
      method: 'POST', pathname: '/api/invoke/config%3Asave',
      headers: rpcHeaders(app), body: JSON.stringify({ args: [saved] }),
    })
    expect(saveRes.status).toBe(200)
    expect(JSON.parse(saveRes.text)).toEqual({ ok: true, value: { ok: true } })

    const loadRes = await request(app, {
      method: 'POST', pathname: '/api/invoke/config%3Aload',
      headers: rpcHeaders(app), body: JSON.stringify({ args: [] }),
    })
    expect(JSON.parse(loadRes.text)).toEqual({ ok: true, value: saved })

    await close(app)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('serial:list 通过 RPC 返回稳定的串口数组', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modbusmate-web-serial-'))
    const runtime = createRealRuntime(path.join(dir, 'config.json'))
    const app = await start({ runtime })

    const res = await request(app, {
      method: 'POST', pathname: '/api/invoke/serial%3Alist',
      headers: rpcHeaders(app), body: JSON.stringify({ args: [] }),
    })
    expect(JSON.parse(res.text)).toEqual({
      ok: true,
      value: [{ path: 'COM3', manufacturer: 'FTDI' }, { path: '/dev/tty.usbserial-1' }],
    })

    await close(app)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('非法 token、Origin 和路径穿越均被拒绝', async () => {
    const app = await start()
    const noToken = await request(app, {
      method: 'POST', pathname: '/api/invoke/config%3Aload',
      headers: { ...rpcHeaders(app), 'x-modbusmate-token': '' }, body: JSON.stringify({ args: [] }),
    })
    expect(noToken.status).toBe(401)

    const badOrigin = await request(app, {
      method: 'POST', pathname: '/api/invoke/config%3Aload',
      headers: { ...rpcHeaders(app), origin: 'http://evil.test' }, body: JSON.stringify({ args: [] }),
    })
    expect(badOrigin.status).toBe(403)

    const traversal = await request(app, { pathname: '/..%2fpackage.json' })
    expect([400, 403, 404]).toContain(traversal.status)

    await close(app)
  })

  it('服务关闭后端口可立即被重新绑定', async () => {
    const first = await start()
    const port = first.address.port
    await close(first)

    const second = await start({ port })
    expect(second.address.port).toBe(port)
    await close(second)
  })

  it('页面同时包含调试工作台与实例弹窗的全部 TCP/RTU 必需字段', async () => {
    const app = await start()
    const index = await request(app)
    for (const id of [
      'transport', 'tcpFields', 'host', 'port', 'rtuFields', 'serialPath', 'refreshSerialBtn',
      'baudRate', 'dataBits', 'parity', 'stopBits', 'unitId', 'timeout',
      'instTransport', 'instTcpFields', 'instHost', 'instPort', 'instRtuFields', 'instSerialPath',
      'instRefreshSerialBtn', 'instBaudRate', 'instDataBits', 'instParity', 'instStopBits',
      'instUnitId', 'instTimeout',
    ]) {
      expect(index.text, id).toContain(`id="${id}"`)
    }
    await close(app)
  })
})

describe('Web CLI 纯函数', () => {
  it('解析 --no-open、--port 和环境变量', () => {
    expect(parseCliArgs(['--no-open', '--port', '9001'], {
      MODBUSMATE_WEB_PORT: '8123', MODBUSMATE_DATA_DIR: '/tmp/mm',
    })).toEqual({ open: false, port: 9001, dataDir: '/tmp/mm', lan: false, noToken: false })
    expect(parseCliArgs([], { MODBUSMATE_WEB_PORT: '8123' })).toMatchObject({ open: true, port: 8123, lan: false })
    expect(() => parseCliArgs(['--port', 'bad'], {})).toThrow('端口')
  })

  it('--lan 或 MODBUSMATE_WEB_LAN 开启局域网模式', () => {
    expect(parseCliArgs(['--lan'], {})).toMatchObject({ lan: true })
    expect(parseCliArgs([], { MODBUSMATE_WEB_LAN: '1' })).toMatchObject({ lan: true })
    expect(parseCliArgs([], {})).toMatchObject({ lan: false })
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
