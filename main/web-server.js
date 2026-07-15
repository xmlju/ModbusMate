// main/web-server.js — 仅监听本机回环地址的浏览器调试服务
const crypto = require('crypto')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')
const { createConfigStore } = require('./config-store')
const { createWebRuntime, WEB_RUNTIME_CHANNELS } = require('./web-runtime')

const LOOPBACK_HOST = '127.0.0.1'
const DEFAULT_PORT = 8765
const MAX_BODY_BYTES = 1024 * 1024
const CSP = "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'"
const CHANNELS = new Set(WEB_RUNTIME_CHANNELS)
const MIME_TYPES = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.webp': 'image/webp',
})

function securityHeaders(extra = {}) {
  return {
    'Cache-Control': 'no-store',
    'Content-Security-Policy': CSP,
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  }
}

function send(res, status, body = '', headers = {}) {
  const content = Buffer.isBuffer(body) ? body : Buffer.from(String(body))
  res.writeHead(status, securityHeaders({
    'Content-Length': content.length,
    ...headers,
  }))
  res.end(content)
}

function sendJson(res, status, value) {
  send(res, status, JSON.stringify(value), { 'Content-Type': 'application/json; charset=utf-8' })
}

function sendRpcError(res, status, message, headers = {}) {
  send(res, status, JSON.stringify({ ok: false, error: { message } }), {
    'Content-Type': 'application/json; charset=utf-8',
    ...headers,
  })
}

function tokenMatches(expected, actual) {
  const expectedHash = crypto.createHash('sha256').update(expected).digest()
  const actualHash = crypto.createHash('sha256').update(typeof actual === 'string' ? actual : '').digest()
  return crypto.timingSafeEqual(expectedHash, actualHash)
}

function redactText(value, privatePaths) {
  let text = value instanceof Error ? value.message : String(value ?? '')
  for (const privatePath of privatePaths) {
    if (!privatePath) continue
    text = text.split(privatePath).join('[本地路径]')
  }
  return text
}

function publicError(error, privatePaths) {
  const source = error instanceof Error ? error : new Error(String(error))
  const result = { message: redactText(source.message, privatePaths) || '未知错误' }
  if (source.code !== undefined) result.code = String(source.code)
  if (source.cause !== undefined) {
    result.causeMessage = redactText(source.cause, privatePaths)
  }
  if (Array.isArray(source.errors)) {
    result.errors = source.errors.map(item => ({
      message: redactText(item, privatePaths) || '未知错误',
      ...(item?.code === undefined ? {} : { code: String(item.code) }),
    }))
  }
  return result
}

function parsePathname(rawUrl) {
  const rawPath = String(rawUrl || '/').split('?', 1)[0]
  let pathname
  try {
    pathname = decodeURIComponent(rawPath)
  } catch {
    const error = new Error('请求路径编码无效')
    error.statusCode = 400
    throw error
  }
  if (pathname.includes('\0') || pathname.includes('\\')) {
    const error = new Error('请求路径包含非法字符')
    error.statusCode = 400
    throw error
  }
  return pathname
}

async function resolveStaticFile(rendererRoot, rendererRealRoot, rawUrl) {
  const pathname = parsePathname(rawUrl)
  const relative = pathname === '/' ? '/index.html' : pathname
  const candidate = path.resolve(rendererRoot, `.${relative}`)
  if (candidate !== rendererRoot && !candidate.startsWith(`${rendererRoot}${path.sep}`)) {
    const error = new Error('禁止访问页面目录之外的文件')
    error.statusCode = 403
    throw error
  }

  let realFile
  try {
    realFile = await fs.promises.realpath(candidate)
  } catch (cause) {
    const error = new Error('页面文件不存在', { cause })
    error.statusCode = cause?.code === 'ENOENT' || cause?.code === 'ENOTDIR' ? 404 : 500
    throw error
  }
  if (realFile !== rendererRealRoot && !realFile.startsWith(`${rendererRealRoot}${path.sep}`)) {
    const error = new Error('禁止通过符号链接访问页面目录之外的文件')
    error.statusCode = 403
    throw error
  }
  const stats = await fs.promises.stat(realFile)
  if (!stats.isFile()) {
    const error = new Error('页面文件不存在')
    error.statusCode = 404
    throw error
  }
  return { realFile, size: stats.size }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      req.resume()
      const error = new Error('请求体超过 1 MiB 限制')
      error.statusCode = 413
      reject(error)
      return
    }

    const chunks = []
    let size = 0
    let settled = false
    req.on('data', chunk => {
      if (settled) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        settled = true
        req.resume()
        const error = new Error('请求体超过 1 MiB 限制')
        error.statusCode = 413
        reject(error)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (cause) {
        const error = new Error('请求体不是有效 JSON', { cause })
        error.statusCode = 400
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function closeListeningServer(server) {
  if (!server.listening) return Promise.resolve()
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
  })
}

async function startWebServer(options = {}) {
  const host = options.host ?? LOOPBACK_HOST
  if (host !== LOOPBACK_HOST) throw new TypeError('Web 服务只允许监听本机回环地址 127.0.0.1')
  const port = options.port ?? DEFAULT_PORT
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new TypeError('Web 服务端口必须是 0 到 65535 的整数')
  }

  const rendererRoot = path.resolve(options.rendererRoot ?? path.join(__dirname, '..', 'renderer'))
  const rendererRealRoot = await fs.promises.realpath(rendererRoot)
  const dataDir = path.resolve(options.dataDir ?? path.join(os.homedir(), '.modbusmate'))
  const token = options.token ?? crypto.randomBytes(32).toString('base64url')
  if (typeof token !== 'string' || token.length === 0) throw new TypeError('Web 访问令牌不能为空')
  const runtime = options.runtime ?? createWebRuntime({
    configStore: createConfigStore(path.join(dataDir, 'config.json')),
  })
  const sseResponses = new Set()
  let origin
  let expectedHost

  const server = http.createServer(async (req, res) => {
    const rawPath = String(req.url || '/').split('?', 1)[0]
    try {
      if (rawPath.startsWith('/api/invoke/')) {
        if (req.method !== 'POST') {
          sendRpcError(res, 405, '方法不允许', { Allow: 'POST' })
          return
        }
        let channel
        try { channel = decodeURIComponent(rawPath.slice('/api/invoke/'.length)) } catch { channel = '' }
        if (!channel || channel.includes('/') || !CHANNELS.has(channel)) {
          sendRpcError(res, 404, 'RPC 通道不存在')
          return
        }
        if (!tokenMatches(token, req.headers['x-modbusmate-token'])) {
          sendRpcError(res, 401, '访问令牌无效')
          return
        }
        if (req.headers.origin !== origin || req.headers.host !== expectedHost) {
          sendRpcError(res, 403, '仅允许当前本地页面调用')
          return
        }
        const contentType = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase()
        if (contentType !== 'application/json') {
          sendRpcError(res, 415, '请求体必须使用 application/json')
          return
        }
        const body = await readJsonBody(req)
        if (!body || typeof body !== 'object' || Array.isArray(body) ||
            !Array.isArray(body.args) || Object.keys(body).length !== 1) {
          sendRpcError(res, 400, '请求体必须严格为 {args: [...]}')
          return
        }
        try {
          const value = await runtime.invoke(channel, ...body.args)
          sendJson(res, 200, { ok: true, value: value === undefined ? null : value })
        } catch (error) {
          sendJson(res, 500, { ok: false, error: publicError(error, [dataDir, rendererRoot]) })
        }
        return
      }

      if (rawPath === '/api/events') {
        if (req.method !== 'GET') {
          send(res, 405, '方法不允许', { Allow: 'GET' })
          return
        }
        const requestUrl = new URL(req.url, origin)
        if (!tokenMatches(token, requestUrl.searchParams.get('token'))) {
          send(res, 401, '访问令牌无效')
          return
        }
        if (req.headers.origin !== undefined && req.headers.origin !== origin) {
          send(res, 403, '事件流仅允许同源页面访问')
          return
        }
        if (req.headers.host !== expectedHost) {
          send(res, 403, '事件流 Host 无效')
          return
        }

        res.writeHead(200, securityHeaders({
          'Content-Type': 'text/event-stream; charset=utf-8',
          Connection: 'keep-alive',
        }))
        res.write(`data: ${JSON.stringify({ channel: 'ready', payload: null })}\n\n`)
        const onEvent = event => res.write(`data: ${JSON.stringify(event)}\n\n`)
        const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), options.heartbeatMs ?? 15000)
        heartbeat.unref?.()
        runtime.on('event', onEvent)
        sseResponses.add(res)
        const cleanup = () => {
          clearInterval(heartbeat)
          runtime.removeListener('event', onEvent)
          sseResponses.delete(res)
        }
        req.once('close', cleanup)
        res.once('close', cleanup)
        return
      }

      if (rawPath.startsWith('/api/')) {
        send(res, 404, '接口不存在')
        return
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        send(res, 405, '方法不允许', { Allow: 'GET, HEAD' })
        return
      }
      const file = await resolveStaticFile(rendererRoot, rendererRealRoot, req.url)
      const contentType = MIME_TYPES[path.extname(file.realFile).toLowerCase()] ?? 'application/octet-stream'
      const headers = securityHeaders({
        'Content-Type': contentType,
        'Content-Length': file.size,
      })
      if (req.method === 'HEAD') {
        res.writeHead(200, headers)
        res.end()
      } else {
        res.writeHead(200, headers)
        const stream = fs.createReadStream(file.realFile)
        stream.on('error', () => {
          if (!res.headersSent) send(res, 500, '页面读取失败')
          else res.destroy()
        })
        stream.pipe(res)
      }
    } catch (error) {
      if (!res.headersSent && rawPath.startsWith('/api/invoke/')) {
        sendRpcError(res, error.statusCode ?? 500, error.statusCode ? error.message : 'RPC 请求处理失败')
      } else if (!res.headersSent) {
        send(res, error.statusCode ?? 500, error.statusCode ? error.message : '本地 Web 服务处理请求失败')
      }
      else res.destroy()
    }
  })

  try {
    await new Promise((resolve, reject) => {
      const onError = error => {
        server.removeListener('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        server.removeListener('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, host)
    })
  } catch (listenError) {
    try {
      await runtime.close()
    } catch (closeError) {
      throw new AggregateError([listenError, closeError], 'Web 服务监听失败，且运行时清理异常')
    }
    throw listenError
  }

  const address = server.address()
  origin = `http://${LOOPBACK_HOST}:${address.port}`
  expectedHost = `${LOOPBACK_HOST}:${address.port}`
  let closePromise
  const close = () => {
    if (closePromise) return closePromise
    closePromise = (async () => {
      const serverPromise = closeListeningServer(server)
      for (const response of sseResponses) response.end()
      sseResponses.clear()
      const results = await Promise.allSettled([serverPromise, Promise.resolve().then(() => runtime.close())])
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason)
      if (errors.length) throw new AggregateError(errors, `本地 Web 服务关闭失败，共 ${errors.length} 个清理步骤异常`)
    })()
    return closePromise
  }

  return {
    server,
    runtime,
    origin,
    url: `${origin}/?token=${encodeURIComponent(token)}`,
    address,
    token,
    close,
  }
}

module.exports = { startWebServer }
