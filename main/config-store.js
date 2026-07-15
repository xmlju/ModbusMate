// main/config-store.js — 与 Electron 无关的 JSON 配置原子存储
const fs = require('fs')
const path = require('path')

const POLLUTION_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
let tempSequence = 0

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function assertSafeKeys(value, location = '配置') {
  if (value === null || typeof value !== 'object') return

  for (const key of Object.keys(value)) {
    if (POLLUTION_KEYS.has(key)) {
      throw new TypeError(`${location}包含不安全字段：${key}`)
    }
    assertSafeKeys(value[key], `${location}.${key}`)
  }
}

function detailedError(prefix, filePath, cause) {
  const detail = cause instanceof Error ? cause.message : String(cause)
  return new Error(`${prefix}：${filePath}；原因：${detail}`, { cause })
}

function createTempPath(filePath) {
  tempSequence += 1
  return path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${tempSequence}.tmp`,
  )
}

function createConfigStore(filePath, io = fs) {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw new TypeError('配置文件位置不能为空')
  }

  return {
    load() {
      if (!io.existsSync(filePath)) return {}

      try {
        const config = JSON.parse(io.readFileSync(filePath, 'utf8'))
        if (!isPlainObject(config)) throw new TypeError('配置文件根节点必须是普通对象')
        assertSafeKeys(config)
        return config
      } catch (cause) {
        throw detailedError('配置文件解析失败', filePath, cause)
      }
    },

    save(config) {
      let tempPath
      try {
        if (!isPlainObject(config)) throw new TypeError('待保存配置必须是普通对象')
        assertSafeKeys(config)

        io.mkdirSync(path.dirname(filePath), { recursive: true })
        tempPath = createTempPath(filePath)
        io.writeFileSync(tempPath, JSON.stringify(config, null, 2), 'utf8')
        io.renameSync(tempPath, filePath)
        return { ok: true }
      } catch (cause) {
        if (tempPath) {
          try { io.unlinkSync(tempPath) } catch (cleanupError) {
            // 清理失败不能覆盖原始磁盘错误，但保留下来便于诊断残留临时文件。
            if (cause && (typeof cause === 'object' || typeof cause === 'function')) {
              cause.cleanupError = cleanupError
            }
          }
        }
        throw detailedError('配置保存失败', filePath, cause)
      }
    },
  }
}

module.exports = { createConfigStore }
