#!/usr/bin/env node
/**
 * generate-codes.js — 离线生成激活码
 * 用法：node scripts/generate-codes.js <数量> [起始序号]
 * 示例：node scripts/generate-codes.js 100
 * 输出：codes.txt（每行一个码）
 */
const crypto = require('crypto')
const fs     = require('fs')
const path   = require('path')

// ── 密钥从环境变量读取，不落盘、不入库 ────────────────────────
const SECRET = process.env.MM_SECRET
if (!SECRET) {
  console.error('缺少环境变量 MM_SECRET。用法：MM_SECRET=<密钥> node scripts/generate-codes.js 100')
  process.exit(1)
}

// 合法字符集（去除 0/O/I/l 易混淆字符），共32个
const CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

// serial → 4位 CHARS 编码（base32）
function encodeSerial(n) {
  let s = ''
  for (let i = 0; i < 4; i++) {
    s = CHARS[n & 0x1F] + s
    n >>= 5
  }
  return s
}

// serial → 4位 HMAC 校验码
function checksum(serial) {
  const hmac = crypto.createHmac('sha256', SECRET)
  hmac.update(String(serial))
  const buf = hmac.digest()
  let bits = 0, bitCount = 0, out = ''
  for (let i = 0; i < buf.length && out.length < 4; i++) {
    bits = (bits << 8) | buf[i]
    bitCount += 8
    while (bitCount >= 5 && out.length < 4) {
      bitCount -= 5
      out += CHARS[(bits >> bitCount) & 0x1F]
    }
  }
  return out
}

function serialToCode(serial) {
  return encodeSerial(serial) + '-' + checksum(serial)
}

const count = parseInt(process.argv[2]) || 50
const start = parseInt(process.argv[3]) || 1

const lines = []
for (let i = start; i < start + count; i++) {
  lines.push(serialToCode(i))
}

const outFile = path.join(__dirname, '..', 'codes.txt')
fs.writeFileSync(outFile, lines.join('\n') + '\n', 'utf-8')
console.log(`✅ 生成 ${count} 个激活码 → codes.txt`)
console.log('前5个预览：')
lines.slice(0, 5).forEach(c => console.log(' ', c))
