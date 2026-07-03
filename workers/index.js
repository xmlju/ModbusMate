/**
 * ModbusMate — Cloudflare Worker
 *
 * 必须在 Cloudflare Dashboard → Workers → Settings → Variables 中设置：
 *   SECRET    = 与 generate-codes.js 相同的密钥（激活码 HMAC 密钥）
 *   SIGN_KEY  = Token 签名密钥
 *   ADMIN_KEY = 管理员密钥（用于 /revoke 接口）
 *
 * 如需吊销功能，还需绑定 KV 命名空间：
 *   MM_KV     = 在 Cloudflare KV 创建后绑定变量名为 MM_KV
 */

const CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const TOKEN_DAYS = 30  // Token 有效天数

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS })

    const url = new URL(request.url)

    if (url.pathname === '/verify' && request.method === 'POST') {
      return handleVerify(request, env)
    }
    if (url.pathname === '/revoke' && request.method === 'POST') {
      return handleRevoke(request, env)
    }

    return jsonResp({ service: 'ModbusMate', status: 'ok' })
  }
}

// ── POST /verify ──────────────────────────────────────────────
async function handleVerify(request, env) {
  let body
  try { body = await request.json() } catch { return jsonResp({ ok: false, error: 'bad_request' }, 400) }

  const code     = String(body.code ?? '').trim().toUpperCase().replace(/\s/g, '')
  const deviceId = String(body.deviceId ?? '').trim().slice(0, 64)
  if (!code) return jsonResp({ ok: false, error: 'missing_code' })

  // 验证激活码（HMAC）
  if (!await isValidCode(code, env.SECRET)) {
    return jsonResp({ ok: false, error: 'invalid_code' })
  }

  // 检查吊销名单
  if (env.MM_KV) {
    const revoked = await env.MM_KV.get(`revoked:${code}`)
    if (revoked) return jsonResp({ ok: false, error: 'revoked' })
  }

  // 设备绑定检查（需 KV + deviceId）
  if (env.MM_KV && deviceId) {
    const boundDevice = await env.MM_KV.get(`bound:${code}`)
    if (boundDevice && boundDevice !== deviceId) {
      return jsonResp({ ok: false, error: 'code_already_used' })
    }
    if (!boundDevice) {
      await env.MM_KV.put(`bound:${code}`, deviceId)
    }
  }

  // 生成 Token（有效期 30 天）
  const expiry = new Date()
  expiry.setDate(expiry.getDate() + TOKEN_DAYS)
  const expires = expiry.toISOString().slice(0, 10)
  const token = await hmacHex(env.SIGN_KEY, `${code}.${expires}`)

  return jsonResp({ ok: true, token, expires })
}

// ── POST /revoke ──────────────────────────────────────────────
async function handleRevoke(request, env) {
  let body
  try { body = await request.json() } catch { return jsonResp({ ok: false, error: 'bad_request' }, 400) }

  if (!env.ADMIN_KEY || body.admin_key !== env.ADMIN_KEY) {
    return jsonResp({ ok: false, error: 'forbidden' }, 403)
  }
  if (!env.MM_KV) return jsonResp({ ok: false, error: 'kv_not_bound' })

  const code = String(body.code ?? '').trim().toUpperCase()
  if (!code) return jsonResp({ ok: false, error: 'missing_code' })

  await env.MM_KV.put(`revoked:${code}`, '1')
  return jsonResp({ ok: true, revoked: code })
}

// ── 激活码验证算法（与 generate-codes.js 一致）──────────────────
function decodeSerial(s) {
  let n = 0
  for (const c of s) {
    const idx = CHARS.indexOf(c)
    if (idx < 0) return -1
    n = (n << 5) | idx
  }
  return n
}

async function computeChecksum(serial, secret) {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(String(serial)))
  const buf = new Uint8Array(sig)
  let bits = 0, bitCount = 0, out = ''
  for (let i = 0; i < buf.length && out.length < 4; i++) {
    bits = (bits << 8) | buf[i]; bitCount += 8
    while (bitCount >= 5 && out.length < 4) {
      bitCount -= 5; out += CHARS[(bits >> bitCount) & 0x1F]
    }
  }
  return out
}

async function isValidCode(code, secret) {
  if (!/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/.test(code)) return false
  const [s, c] = code.split('-')
  const serial = decodeSerial(s)
  if (serial <= 0) return false
  return (await computeChecksum(serial, secret)) === c
}

async function hmacHex(key, data) {
  const enc = new TextEncoder()
  const k = await crypto.subtle.importKey(
    'raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', k, enc.encode(data))
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('')
}

function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' }
  })
}
