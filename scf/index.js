/**
 * 腾讯云 SCF Web函数 — ModbusMate 激活验证
 * 环境变量：SECRET、SIGN_KEY、COS_SECRET_ID、COS_SECRET_KEY、COS_BUCKET、COS_REGION
 */
const http   = require('http')
const https  = require('https')
const crypto = require('crypto')

const CHARS      = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const TOKEN_DAYS = 30

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

// ── COS KV（用于设备绑定）──────────────────────────────────────
function cosAuth(method, objKey) {
  const { COS_SECRET_ID: sid, COS_SECRET_KEY: skey, COS_BUCKET: bucket } = process.env
  const host    = `${bucket}.cos.${process.env.COS_REGION}.myqcloud.com`
  const now     = Math.floor(Date.now() / 1000)
  const keyTime = `${now};${now + 300}`
  const signKey = crypto.createHmac('sha1', skey).update(keyTime).digest('hex')
  const httpStr = `${method.toLowerCase()}\n/${objKey}\n\nhost=${host}\n`
  const hashHttp = crypto.createHash('sha1').update(httpStr).digest('hex')
  const strToSign = `sha1\n${keyTime}\n${hashHttp}\n`
  const sig = crypto.createHmac('sha1', signKey).update(strToSign).digest('hex')
  return {
    host,
    auth: `q-sign-algorithm=sha1&q-ak=${sid}&q-sign-time=${keyTime}&q-key-time=${keyTime}&q-header-list=host&q-url-param-list=&q-signature=${sig}`
  }
}

function cosEnabled() {
  const e = process.env
  return e.COS_SECRET_ID && e.COS_SECRET_KEY && e.COS_BUCKET && e.COS_REGION
}

async function kvGet(key) {
  if (!cosEnabled()) return null
  const { host, auth } = cosAuth('GET', key)
  return new Promise(resolve => {
    const req = https.request(
      { hostname: host, path: `/${key}`, method: 'GET', headers: { host, Authorization: auth } },
      res => {
        let data = ''
        res.on('data', c => data += c)
        res.on('end', () => resolve(res.statusCode === 200 ? data : null))
      }
    )
    req.on('error', () => resolve(null))
    req.setTimeout(4000, () => { req.destroy(); resolve(null) })
    req.end()
  })
}

async function kvPut(key, value) {
  if (!cosEnabled()) return
  const { host, auth } = cosAuth('PUT', key)
  const body = Buffer.from(String(value))
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: host, path: `/${key}`, method: 'PUT',
        headers: { host, Authorization: auth, 'Content-Length': body.length, 'Content-Type': 'text/plain' }
      },
      res => { res.resume(); res.on('end', resolve) }
    )
    req.on('error', reject)
    req.setTimeout(4000, () => { req.destroy(); reject(new Error('timeout')) })
    req.write(body)
    req.end()
  })
}

// ── 激活码验证 ────────────────────────────────────────────────
function decodeSerial(s) {
  let n = 0
  for (const c of s) {
    const idx = CHARS.indexOf(c)
    if (idx < 0) return -1
    n = (n << 5) | idx
  }
  return n
}

function computeChecksum(serial, secret) {
  const buf = crypto.createHmac('sha256', secret).update(String(serial)).digest()
  let bits = 0, bitCount = 0, out = ''
  for (let i = 0; i < buf.length && out.length < 4; i++) {
    bits = (bits << 8) | buf[i]; bitCount += 8
    while (bitCount >= 5 && out.length < 4) {
      bitCount -= 5; out += CHARS[(bits >> bitCount) & 0x1F]
    }
  }
  return out
}

function isValidCode(code, secret) {
  if (!/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/.test(code)) return false
  const [s, c] = code.split('-')
  const serial = decodeSerial(s)
  if (serial <= 0) return false
  return computeChecksum(serial, secret) === c
}

function hmacHex(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest('hex')
}

// ── HTTP 服务器 ───────────────────────────────────────────────
const server = http.createServer((req, res) => {
  function send(data, status = 200) {
    res.writeHead(status, { ...CORS, 'Content-Type': 'application/json' })
    res.end(JSON.stringify(data))
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(200, CORS)
    return res.end()
  }

  if (req.method === 'GET') {
    return send({ service: 'ModbusMate', status: 'ok' })
  }

  if (req.method !== 'POST') {
    return send({ ok: false, error: 'method_not_allowed' }, 405)
  }

  let raw = ''
  req.on('data', c => raw += c)
  req.on('end', async () => {
    console.log(`[req] ${req.method} ${req.url} raw=${raw.slice(0, 200)}`)
    let body = {}
    try { body = JSON.parse(raw) } catch { return send({ ok: false, error: 'bad_request' }, 400) }

    const url = req.url.split('?')[0]

    if (url === '/verify') {
      const code     = String(body.code     ?? '').trim().toUpperCase().replace(/\s/g, '')
      const deviceId = String(body.deviceId ?? '').trim().slice(0, 64)
      const SECRET   = process.env.SECRET
      const SIGN_KEY = process.env.SIGN_KEY

      if (!code)                       return send({ ok: false, error: 'missing_code' })
      if (!isValidCode(code, SECRET))  return send({ ok: false, error: 'invalid_code' })

      // 吊销检查
      const revoked = await kvGet(`revoked_${code}`)
      if (revoked) return send({ ok: false, error: 'revoked' })

      // 设备绑定
      if (deviceId && cosEnabled()) {
        try {
          const boundDevice = await kvGet(`bound_${code}`)
          console.log(`[bind] code=${code} bound=${boundDevice} incoming=${deviceId}`)
          if (boundDevice && boundDevice !== deviceId) {
            return send({ ok: false, error: 'code_already_used' })
          }
          if (!boundDevice) {
            await kvPut(`bound_${code}`, deviceId)
            console.log(`[bind] saved bound_${code} = ${deviceId}`)
          }
        } catch (e) {
          console.error('[bind] COS error:', e.message)
          // COS 异常时仍放行，避免影响正常激活
        }
      } else {
        console.log(`[bind] skip — deviceId=${!!deviceId} cosEnabled=${cosEnabled()}`)
      }

      const expiry = new Date()
      expiry.setDate(expiry.getDate() + TOKEN_DAYS)
      const expires = expiry.toISOString().slice(0, 10)
      const token   = hmacHex(SIGN_KEY, `${code}.${expires}`)

      return send({ ok: true, token, expires })
    }

    send({ service: 'ModbusMate', status: 'ok' })
  })
})

server.listen(9000, () => {
  console.log('ModbusMate SCF 启动，监听 9000')
})
