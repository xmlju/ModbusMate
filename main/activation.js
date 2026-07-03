// main/activation.js — 激活验证：服务端换 Token + 本地 HMAC 验签（30 天 + 7 天宽限）
// 部署激活服务后，回填下方 VERIFY_URLS 与 SIGN_KEY（见 Task 14）
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const VERIFY_URLS = [
  'https://REPLACE-WITH-SCF-URL/verify',       // 腾讯云 SCF（主，国内直连）
  'https://REPLACE-WITH-WORKER-URL/verify',    // Cloudflare Worker（备）
]
const SIGN_KEY = 'REPLACE_WITH_SIGN_KEY'       // 与服务端 SIGN_KEY 一致
const GRACE_MS = 7 * 24 * 60 * 60 * 1000       // 断网宽限 7 天
const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/

// 纯函数便于单测：验签 Token（无需联网）
function verifyToken(code, token, expires, signKey) {
  if (!code || !token || !expires) return false
  if (Date.now() > new Date(expires).getTime() + GRACE_MS) return false
  const expected = crypto.createHmac('sha256', signKey).update(`${code}.${expires}`).digest('hex')
  return expected === token
}

class Activation {
  constructor(userDataPath) {
    this.file = path.join(userDataPath, 'activation.json')
  }

  _load() { try { return JSON.parse(fs.readFileSync(this.file, 'utf8')) } catch { return {} } }
  _save(data) { fs.writeFileSync(this.file, JSON.stringify(data)) }

  // 持久化设备 ID（一码一设备绑定用）
  getDeviceId() {
    const d = this._load()
    if (d.deviceId) return d.deviceId
    const deviceId = crypto.randomUUID()
    this._save({ ...d, deviceId })
    return deviceId
  }

  isActivated() {
    if (process.env.MM_DEV === '1') return true   // 开发模式跳过激活
    const { code, token, expires } = this._load()
    return verifyToken(code, token, expires, SIGN_KEY)
  }

  // 服务端验证激活码，成功则缓存 Token；返回 { ok } 或 { ok:false, error:中文提示 }
  async activate(inputCode) {
    const code = String(inputCode).trim().toUpperCase().replace(/\s/g, '')
    if (!CODE_RE.test(code)) return { ok: false, error: '激活码格式不正确，应为 XXXX-XXXX' }
    const deviceId = this.getDeviceId()
    for (const url of VERIFY_URLS) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, deviceId }),
          signal: AbortSignal.timeout(8000),
        })
        const data = await res.json()
        if (data.ok) {
          this._save({ ...this._load(), code, token: data.token, expires: data.expires })
          return { ok: true }
        }
        if (data.error === 'code_already_used') return { ok: false, error: '该激活码已在其他设备使用，请联系作者' }
        if (data.error === 'revoked') return { ok: false, error: '该激活码已被停用，请联系作者' }
        if (data.error === 'invalid_code') return { ok: false, error: '激活码无效，请检查输入' }
      } catch { /* 当前节点超时/失败，尝试下一个 */ }
    }
    return { ok: false, error: '无法连接激活服务器，请检查网络后重试' }
  }
}

module.exports = { Activation, verifyToken }
