// main/activation.js — 激活验证（当前已注释禁用，始终返回已激活）
// const crypto = require('crypto')
// const fs = require('fs')
// const path = require('path')
//
// const VERIFY_URLS = [ ... ]
// const SIGN_KEY = 'REPLACE_WITH_SIGN_KEY'
// const GRACE_MS = 7 * 24 * 60 * 60 * 1000
// const CODE_RE = /^...$/
//
// function verifyToken(code, token, expires, signKey) { ... }
//
// class Activation {
//   constructor(userDataPath) { ... }
//   _load() { ... }
//   _save(data) { ... }
//   getDeviceId() { ... }
//   isActivated() { ... }  // 始终返回 true，跳过激活检查
//   async activate(inputCode) { ... }
// }

// ── 简化版：始终返回已激活，不做任何网络请求 ──
class Activation {
  constructor() {}
  getDeviceId() { return 'dev-bypass' }
  isActivated() { return true }
  async activate() { return { ok: true } }
}

module.exports = { Activation, verifyToken: () => true }
